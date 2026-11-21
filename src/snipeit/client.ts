import { ConfigError, readEnvInteger } from '../config-env.js';
import { describeUrl, registerSecret, requestIdFrom, SnipeItAnswerError, SnipeItHttpError } from '../errors.js';
import type { SecretRedactor } from '../upstream-http.js';
import { isPublicAddress, pinnedFetch, systemResolve, type ResolveHost } from './network.js';

/** Error responses are read up to this many bytes. */
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const MAX_TIMEOUT_MS = 10 * 60 * 1000;
/** Largest successful JSON answer an embedded client reads. */
const MAX_EMBEDDED_RESPONSE_BYTES = 10 * 1024 * 1024;
/** Time limit per request of an embedded client when the host gives none. */
const EMBEDDED_DEFAULT_TIMEOUT_MS = 30_000;

/** Our own text when the connection's check refuses a private or local address. */
export const PRIVATE_ADDRESS_REFUSED = 'Refused: the Snipe-IT address points to a private or local network address.';

/** Our own text when Snipe-IT answers HTTP 200 with `{"status":"error"}`: its messages are never passed on. */
export const SNIPEIT_REFUSED =
  'Snipe-IT refused the request (it answered with status "error"). Check the ids and values; Snipe-IT’s own message is not passed on.';

export interface SnipeItClientOptions {
  apiToken?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /**
   * Embedded (gateway) client: no SNIPEIT_* variable is read (token, address
   * and time limit come from the options only), the token goes to `redactor`
   * instead of the process-wide registry, the base URL must already be
   * normalised by normalizeSnipeItBaseUrl, every connection goes only to
   * public addresses (DNS checked), no response body is ever read into an
   * error, and an answer that is not JSON is refused.
   */
  embedded?: { redactor: SecretRedactor; resolveHost?: ResolveHost };
}

/** Our own guidance per HTTP status (embedded client). */
const STATUS_HINTS: Record<number, string> = {
  401: 'Snipe-IT rejected the API key (invalid, expired or revoked). Retrying will not help.',
  403: 'The Snipe-IT user behind the API key has no permission for this. Retrying will not help.',
  404: 'Snipe-IT found nothing at this address. Check the ids.',
  422: 'Snipe-IT refused the values. Check the ids and values against list_reference_data.',
  429: 'Snipe-IT is throttling requests. Wait and retry later.',
};

/** System error codes a network error may name: a fixed list, so no other text from a cause is ever shown. */
const SHOWN_NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

export type QueryValue = string | number | boolean | null | undefined;

/** Subset of GET /users/me used to identify the owner of a token. */
export interface SnipeItIdentity {
  id?: number;
  username?: string;
  name?: string;
  email?: string;
}

/**
 * Client for the Snipe-IT REST API v1.
 *
 * Critical quirk: Snipe-IT returns HTTP 200 for business failures — the
 * real outcome is the JSON envelope {status: "error"|"success", messages,
 * payload}. List endpoints return {total, rows} with no status field.
 * This client throws on status==="error" so tools never mistake a
 * failed operation for a success.
 */
export class SnipeItClient {
  private readonly apiToken?: string;
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly embedded?: { redactor: SecretRedactor; resolveHost: ResolveHost; hostFetch: boolean };

  constructor(options: SnipeItClientOptions = {}) {
    if (options.embedded) {
      // Nothing from the environment: token, address and time limit come from the host only.
      this.apiToken = options.apiToken;
      options.embedded.redactor.addSecret(this.apiToken);
      const resolveHost = options.embedded.resolveHost ?? systemResolve;
      this.embedded = { redactor: options.embedded.redactor, resolveHost, hostFetch: options.fetchImpl !== undefined };
      const root = trimTrailingSlash(options.baseUrl ?? '');
      if (!root) {
        throw new Error('No Snipe-IT address is configured for this connection.');
      }
      this.baseUrl = `${root}/api/v1`;
      // The built-in fetch connects only to public addresses, checked for every new connection (network.ts).
      this.fetchImpl = options.fetchImpl ?? pinnedFetch(resolveHost);
      this.timeoutMs = options.timeoutMs ?? EMBEDDED_DEFAULT_TIMEOUT_MS;
      if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > MAX_TIMEOUT_MS) {
        throw new ConfigError(`timeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}.`);
      }
      return;
    }
    this.apiToken = options.apiToken ?? process.env.SNIPEIT_API_TOKEN;
    registerSecret(this.apiToken);
    const root = trimTrailingSlash(options.baseUrl ?? process.env.SNIPEIT_BASE_URL ?? '');
    if (!root) {
      throw new Error('Missing SNIPEIT_BASE_URL (e.g. https://assets.example.com).');
    }
    assertSafeBaseUrl(root);
    this.baseUrl = root.endsWith('/api/v1') ? root : `${root}/api/v1`;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? readEnvInteger('SNIPEIT_TIMEOUT_MS', 30_000, { max: MAX_TIMEOUT_MS });
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new ConfigError('timeoutMs must be a positive integer.');
    }
  }

  /** A copy of this client bound to a different token — one per calling user. */
  withToken(apiToken: string): SnipeItClient {
    if (this.embedded) {
      throw new Error('An embedded Snipe-IT client has one API key only.');
    }
    return new SnipeItClient({
      apiToken,
      baseUrl: this.baseUrl,
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
    });
  }

  /**
   * Resolve who a token belongs to, via GET /users/me.
   *
   * Used at enrollment so a bad or revoked token is rejected on the spot rather
   * than surfacing later as a confusing 401 on the user's first real question,
   * and so the form can confirm WHICH Snipe-IT account was linked — someone
   * holding several tokens needs to see they pasted the right one.
   */
  async verifyToken(apiToken: string): Promise<SnipeItIdentity> {
    const body = await this.withToken(apiToken).get<SnipeItIdentity | null>('/users/me');
    return body ?? {};
  }

  async get<T>(path: string, query?: Record<string, QueryValue>): Promise<T> {
    return this.request<T>('GET', path, query);
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, undefined, body);
  }

  async patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PATCH', path, undefined, body);
  }

  buildUrl(path: string, query?: Record<string, QueryValue>): string {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const url = new URL(`${this.baseUrl}${normalizedPath}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null || value === '') {
        continue;
      }
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    query?: Record<string, QueryValue>,
    body?: unknown,
  ): Promise<T> {
    if (!this.apiToken) {
      throw new Error(
        this.embedded
          ? 'No Snipe-IT API key is configured for this connection.'
          : 'Missing SNIPEIT_API_TOKEN. Set it in the MCP server environment.',
      );
    }
    if (this.embedded) {
      return this.embeddedRequest<T>(method, path, query, body);
    }

    const url = this.buildUrl(path, query);
    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${this.apiToken}`,
    };

    const init: RequestInit = {
      method,
      headers,
      // Never follow redirects: the token belongs to SNIPEIT_BASE_URL only,
      // and a 307/308 would also replay the request body elsewhere.
      redirect: 'manual',
      signal: AbortSignal.timeout(this.timeoutMs),
    };

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    const response = await this.fetchImpl(url, init);

    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      void response.body?.cancel().catch(() => undefined);
      throw new SnipeItAnswerError(
        `Snipe-IT API responded with a redirect (HTTP ${response.status}) for ${method} ${describeUrl(url)}; ` +
          'redirects are not followed. Check that SNIPEIT_BASE_URL is the final https:// address.',
        response.status,
        requestIdFrom(response.headers),
      );
    }

    if (!response.ok) {
      const responseBody = await readErrorBody(response);
      throw new SnipeItHttpError({
        status: response.status,
        url,
        payload: responseBody,
        retryAfter: response.headers.get('retry-after') ?? undefined,
        requestId: requestIdFrom(response.headers),
        fallbackMessage: typeof responseBody === 'string' ? responseBody : undefined,
      });
    }

    const responseBody = await readResponseBody(response);
    // HTTP 200 does not mean success in Snipe-IT — check the envelope.
    if (isErrorEnvelope(responseBody)) {
      throw new SnipeItHttpError({
        status: response.status,
        url,
        payload: responseBody,
        requestId: requestIdFrom(response.headers),
        fallbackMessage: formatMessages(responseBody.messages),
      });
    }

    return responseBody as T;
  }

  /**
   * A request of an embedded client: everything in our own words. Redirects
   * are never followed, the body of an error answer is never read, a
   * `{"status":"error"}` answer becomes SNIPEIT_REFUSED, and the address and
   * the cause of a network failure are never quoted.
   */
  private async embeddedRequest<T>(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    query?: Record<string, QueryValue>,
    body?: unknown,
  ): Promise<T> {
    const url = this.buildUrl(path, query);
    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${this.apiToken}`,
    };
    const init: RequestInit = {
      method,
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(this.timeoutMs),
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    let response: Response;
    try {
      if (this.embedded!.hostFetch) {
        // The host's fetch connects by itself: the name is checked here, before every request.
        await this.assertPublicHost(new URL(url).hostname);
      }
      response = await this.fetchImpl(url, init);
    } catch (error) {
      throw this.transportError(method, error);
    }

    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      await discard(response);
      throw new SnipeItAnswerError(
        `Snipe-IT API responded with a redirect (HTTP ${response.status}) for ${method}; ` +
          'redirects are not followed. Check that the Snipe-IT address is the final https:// address of the instance.',
        response.status,
        requestIdFrom(response.headers),
      );
    }

    if (!response.ok) {
      // The body is never read: Snipe-IT's text never becomes part of an error.
      await discard(response);
      throw new SnipeItHttpError({
        status: response.status,
        url,
        hint: Object.hasOwn(STATUS_HINTS, response.status) ? STATUS_HINTS[response.status] : undefined,
        retryAfter: wholeNumber(response.headers.get('retry-after') ?? undefined),
        requestId: requestIdFrom(response.headers),
      });
    }

    let read: { bytes: Uint8Array; exceeded: boolean };
    try {
      read = await readUpTo(response, MAX_EMBEDDED_RESPONSE_BYTES);
    } catch (error) {
      throw this.transportError(method, error);
    }
    if (read.exceeded) {
      throw new Error(`The Snipe-IT answer exceeds the ${MAX_EMBEDDED_RESPONSE_BYTES} byte limit (${method}).`);
    }
    const text = new TextDecoder().decode(read.bytes);
    if (!text.trim()) {
      return null as T;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      // Never passed on as text: an answer that is not JSON is not what the API documents.
      throw new Error(`Snipe-IT answered with something that is not JSON (${method}); nothing of it is passed on.`);
    }
    // HTTP 200 does not mean success in Snipe-IT; its messages are not passed on.
    if (isErrorEnvelope(parsed)) {
      throw new SnipeItAnswerError(SNIPEIT_REFUSED, response.status, requestIdFrom(response.headers));
    }
    return parsed as T;
  }

  private async assertPublicHost(hostname: string): Promise<void> {
    let addresses: readonly string[];
    try {
      addresses = await this.embedded!.resolveHost(hostname);
    } catch {
      throw Object.assign(new Error('The Snipe-IT address could not be resolved.'), { code: 'ENOTFOUND' });
    }
    if (addresses.length === 0 || !addresses.every(isPublicAddress)) {
      throw Object.assign(new Error(PRIVATE_ADDRESS_REFUSED), { code: 'ERR_SNIPEIT_PRIVATE_ADDRESS' });
    }
  }

  /** A network failure or timeout in our own words: no address, no cause text, only a code from a fixed list. */
  private transportError(method: string, error: unknown): Error {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      return Object.assign(new Error(`Snipe-IT API request timed out after ${this.timeoutMs} ms (${method}).`), {
        name: 'TimeoutError',
      });
    }
    const codes = causeCodes(error);
    if (codes.includes('ERR_SNIPEIT_PRIVATE_ADDRESS')) {
      return new Error(PRIVATE_ADDRESS_REFUSED);
    }
    const shown = codes.find(code => SHOWN_NETWORK_CODES.has(code));
    return new Error(`Network error calling the Snipe-IT API (${method})${shown ? ` (${shown})` : ''}.`);
  }
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // ignore
  }
}

/** The `code` of an error and of every cause below it. */
function causeCodes(error: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== null && typeof current === 'object'; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') codes.push(code);
    current = (current as { cause?: unknown }).cause;
  }
  return codes;
}

/** A header value that is a whole number of at most 9 digits, as text; anything else is dropped. */
function wholeNumber(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && /^\d{1,9}$/.test(trimmed) ? String(Number(trimmed)) : undefined;
}

interface SnipeItEnvelope {
  status?: string;
  messages?: unknown;
  payload?: unknown;
}

function isErrorEnvelope(value: unknown): value is SnipeItEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as SnipeItEnvelope).status === 'error'
  );
}

export function formatMessages(messages: unknown): string {
  if (typeof messages === 'string') {
    return messages;
  }
  if (messages && typeof messages === 'object') {
    return Object.entries(messages as Record<string, unknown>)
      .map(([field, errors]) => `${field}: ${Array.isArray(errors) ? errors.join('; ') : String(errors)}`)
      .join(' | ');
  }
  return String(messages ?? 'unknown error');
}

/** Read at most `limit` bytes of the body; cancels the rest and reports whether it was longer. */
async function readUpTo(response: Response, limit: number): Promise<{ bytes: Uint8Array; exceeded: boolean }> {
  if (!response.body) {
    return { bytes: new Uint8Array(0), exceeded: false };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let exceeded = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (total + value.byteLength > limit) {
      chunks.push(value.subarray(0, limit - total));
      total = limit;
      exceeded = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, exceeded };
}

/** Error bodies are read up to a small limit; JSON is parsed only when complete. */
async function readErrorBody(response: Response): Promise<unknown> {
  const { bytes, exceeded } = await readUpTo(response, MAX_ERROR_BODY_BYTES);
  const text = new TextDecoder().decode(bytes);
  if (!text) {
    return null;
  }
  if (exceeded) {
    return text;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function trimTrailingSlash(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') {
    end -= 1;
  }
  return value.slice(0, end);
}

function assertSafeBaseUrl(baseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`SNIPEIT_BASE_URL is not a valid URL: ${baseUrl}`);
  }

  if (parsed.protocol === 'https:') {
    return;
  }
  if (parsed.protocol === 'http:' && isLocalHost(parsed.hostname)) {
    return;
  }
  throw new Error(
    `Refusing to send the Snipe-IT token over ${parsed.protocol}//. Use https:// (loopback http:// is allowed for local mocks).`,
  );
}

function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}
