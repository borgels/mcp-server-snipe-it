import { ConfigError, readEnvInteger } from '../config-env.js';
import { describeUrl, registerSecret, SnipeItHttpError } from '../errors.js';

/** Error responses are read up to this many bytes. */
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const MAX_TIMEOUT_MS = 10 * 60 * 1000;

export interface SnipeItClientOptions {
  apiToken?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

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

  constructor(options: SnipeItClientOptions = {}) {
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
      throw new Error('Missing SNIPEIT_API_TOKEN. Set it in the MCP server environment.');
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
      throw new Error(
        `Snipe-IT API responded with a redirect (HTTP ${response.status}) for ${method} ${describeUrl(url)}; ` +
          'redirects are not followed. Check that SNIPEIT_BASE_URL is the final https:// address.',
      );
    }

    if (!response.ok) {
      const responseBody = await readErrorBody(response);
      throw new SnipeItHttpError({
        status: response.status,
        url,
        payload: responseBody,
        retryAfter: response.headers.get('retry-after') ?? undefined,
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
        fallbackMessage: formatMessages(responseBody.messages),
      });
    }

    return responseBody as T;
  }
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
