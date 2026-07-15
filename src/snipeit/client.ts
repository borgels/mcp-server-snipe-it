import { SnipeItHttpError } from '../errors.js';

export interface SnipeItClientOptions {
  apiToken?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export type QueryValue = string | number | boolean | null | undefined;

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
    const root = trimTrailingSlash(options.baseUrl ?? process.env.SNIPEIT_BASE_URL ?? '');
    if (!root) {
      throw new Error('Missing SNIPEIT_BASE_URL (e.g. https://assets.example.com).');
    }
    assertSafeBaseUrl(root);
    this.baseUrl = root.endsWith('/api/v1') ? root : `${root}/api/v1`;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? Number(process.env.SNIPEIT_TIMEOUT_MS ?? 30_000);
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
      signal: AbortSignal.timeout(this.timeoutMs),
    };

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    const response = await this.fetchImpl(url, init);
    const responseBody = await readResponseBody(response);

    if (!response.ok) {
      throw new SnipeItHttpError({
        status: response.status,
        url,
        payload: responseBody,
        retryAfter: response.headers.get('retry-after') ?? undefined,
        fallbackMessage: typeof responseBody === 'string' ? responseBody : undefined,
      });
    }

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
