export interface SnipeItErrorPayload {
  error?: string;
  message?: string;
  code?: string | number;
}

/** Maximum length of any single piece of text taken from a response body. */
export const MAX_ERROR_TEXT = 500;
/** Configured secrets shorter than this are not redacted by value (too likely to hit normal text). */
const MIN_SECRET_LENGTH = 8;

const registeredSecrets = new Set<string>();

/** Redact this exact value (and its URL-encoded form) wherever it appears in error text. */
export function registerSecret(value: string | undefined): void {
  if (!value || value.length < MIN_SECRET_LENGTH) {
    return;
  }
  registeredSecrets.add(value);
  const encoded = encodeURIComponent(value);
  if (encoded !== value) {
    registeredSecrets.add(encoded);
  }
}

/** Origin and path of a URL, without query string or fragment. */
export function describeUrl(url: string | URL): string {
  try {
    const parsed = typeof url === 'string' ? new URL(url) : url;
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '[invalid URL]';
  }
}

/** Truncate after redaction, so a secret cut in half is never left behind. */
export function truncate(value: string, max: number = MAX_ERROR_TEXT): string {
  return value.length > max ? `${value.slice(0, max)}… [truncated, ${value.length} chars]` : value;
}

function textPart(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }
  return truncate(redactSecrets(value.trim()));
}

const SECRET_PATTERNS = [
  /authorization:\s*bearer\s+[^,\s}]+/gi,
  /(apiToken|SNIPEIT_API_TOKEN|api_token)["']?\s*[:=]\s*["']?[^"',\s}]+/gi,
];

export class SnipeItHttpError extends Error {
  readonly status: number;
  readonly url: string;
  readonly payload?: SnipeItErrorPayload | unknown;
  readonly retryAfter?: string;
  /** Snipe-IT's id for the request, when a response header gives one as a UUID or hex id (never in the message). */
  readonly requestId?: string;

  constructor(input: {
    status: number;
    url: string;
    payload?: SnipeItErrorPayload | unknown;
    retryAfter?: string;
    requestId?: string;
    fallbackMessage?: string;
    /** Our own guidance, right after the status (used by the embedded gateway, which reads no body). */
    hint?: string;
  }) {
    super(formatSnipeItHttpError(input));
    this.name = 'SnipeItHttpError';
    this.status = input.status;
    this.url = redactSecrets(describeUrl(input.url));
    this.payload = input.payload;
    this.retryAfter = input.retryAfter;
    this.requestId = vendorRequestId(input.requestId);
  }
}

/**
 * An answer from Snipe-IT that is not an HTTP error but failed: a redirect, which is never followed, or an answer
 * with `"status": "error"` (Snipe-IT answers a refusal with HTTP 200). Our own text, the status it came with and the
 * request id (only in the form such ids have); nothing of the body or the Location.
 */
export class SnipeItAnswerError extends Error {
  readonly status: number;
  readonly requestId?: string;

  constructor(message: string, status: number, requestId?: string) {
    super(message);
    this.name = 'SnipeItAnswerError';
    this.status = status;
    this.requestId = vendorRequestId(requestId);
  }
}

/**
 * Response headers that carry the vendor's own id for a request, most specific first.
 */
export const REQUEST_ID_HEADERS: readonly string[] = [
  'x-request-id',
  'request-id',
  'x-correlation-id',
  'correlation-id',
  'x-ms-request-id',
  'x-amzn-requestid',
];

/**
 * A hex id: one run of hex digits, or groups of at least four hex digits joined by single hyphens (a UUID is one),
 * 8 to 64 characters in all. A name, a sentence or an e-mail address never fits.
 */
const REQUEST_ID_FORM = /^[0-9A-Fa-f]{4,}(?:-[0-9A-Fa-f]{4,})*$/;
/** Six digits and four more: the shape of a Danish personal number. An id that holds it is dropped. */
const PERSONAL_NUMBER_SHAPE = /\d{6}-?\d{4}/;

/**
 * The vendor's request id, only in the form such ids have (a UUID or a hex id of 8 to 64 characters), or
 * undefined. Anything else, and an id that holds the shape of a personal number, is dropped: the value comes from
 * the vendor and is kept only when it cannot be text.
 */
export function vendorRequestId(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const id = value.trim();
  return id.length >= 8 && id.length <= 64 && REQUEST_ID_FORM.test(id) && !PERSONAL_NUMBER_SHAPE.test(id) ? id : undefined;
}

/** The vendor's request id from the first of REQUEST_ID_HEADERS a response has in the right form, or undefined. */
export function requestIdFrom(headers: Headers, names: readonly string[] = REQUEST_ID_HEADERS): string | undefined {
  for (const name of names) {
    const id = vendorRequestId(headers.get(name));
    if (id !== undefined) return id;
  }
  return undefined;
}

/**
 * Metadata about a failed call, for a host that counts failures: the HTTP status Snipe-IT answered with and its
 * request id. Never the response body, Snipe-IT's error code or message, or the input.
 */
export interface FailureMetadata {
  /** The HTTP status of Snipe-IT's answer (100-599). */
  httpStatus: number;
  /** Snipe-IT's own id for the request, as a UUID or hex id only. */
  requestId?: string;
}

/**
 * The failure metadata of an error: an answer from Snipe-IT that failed gives its status and request id. That is an
 * HTTP error, a refused redirect, or a `"status": "error"` answer, whose status is the one it came with (usually 200).
 */
export function failureMetadata(error: unknown): FailureMetadata | undefined {
  if (!(error instanceof SnipeItHttpError) && !(error instanceof SnipeItAnswerError)) return undefined;
  const status = error.status;
  if (!Number.isInteger(status) || status < 100 || status > 599) return undefined;
  const requestId = vendorRequestId(error.requestId);
  return requestId === undefined ? { httpStatus: status } : { httpStatus: status, requestId };
}


export function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return redactSecrets(error.message);
  }

  return redactSecrets(String(error));
}

export function redactSecrets(value: string): string {
  let result = value;
  for (const secret of registeredSecrets) {
    result = result.split(secret).join('[REDACTED]');
  }
  return SECRET_PATTERNS.reduce(
    (current, pattern) =>
      current.replace(pattern, match => {
        const separator = match.includes(':') ? ':' : '=';
        const key = match.split(separator)[0]?.trim() ?? 'secret';
        return `${key}${separator} [REDACTED]`;
      }),
    result,
  );
}

function formatSnipeItHttpError(input: {
  status: number;
  url: string;
  payload?: SnipeItErrorPayload | unknown;
  retryAfter?: string;
  fallbackMessage?: string;
  hint?: string;
}): string {
  const payload = isSnipeItErrorPayload(input.payload) ? input.payload : undefined;
  const parts = [
    `Snipe-IT API request failed with HTTP ${input.status}`,
    input.hint,
    payload?.code === undefined ? undefined : `code=${truncate(redactSecrets(String(payload.code)), 64)}`,
    textPart(payload?.error),
    textPart(payload?.message),
    input.retryAfter ? `retry-after=${truncate(input.retryAfter, 64)}s` : undefined,
    textPart(input.fallbackMessage),
  ].filter(Boolean);

  return redactSecrets(parts.join(' | '));
}

function isSnipeItErrorPayload(value: unknown): value is SnipeItErrorPayload {
  return typeof value === 'object' && value !== null;
}
