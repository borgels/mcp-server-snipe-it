export interface SnipeItErrorPayload {
  error?: string;
  message?: string;
  code?: string | number;
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

  constructor(input: {
    status: number;
    url: string;
    payload?: SnipeItErrorPayload | unknown;
    retryAfter?: string;
    fallbackMessage?: string;
  }) {
    super(formatSnipeItHttpError(input));
    this.name = 'SnipeItHttpError';
    this.status = input.status;
    this.url = redactSecrets(input.url);
    this.payload = input.payload;
    this.retryAfter = input.retryAfter;
  }
}

export function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return redactSecrets(error.message);
  }

  return redactSecrets(String(error));
}

export function redactSecrets(value: string): string {
  return SECRET_PATTERNS.reduce(
    (current, pattern) =>
      current.replace(pattern, match => {
        const separator = match.includes(':') ? ':' : '=';
        const key = match.split(separator)[0]?.trim() ?? 'secret';
        return `${key}${separator} [REDACTED]`;
      }),
    value,
  );
}

function formatSnipeItHttpError(input: {
  status: number;
  url: string;
  payload?: SnipeItErrorPayload | unknown;
  retryAfter?: string;
  fallbackMessage?: string;
}): string {
  const payload = isSnipeItErrorPayload(input.payload) ? input.payload : undefined;
  const parts = [
    `Snipe-IT API request failed with HTTP ${input.status}`,
    payload?.code === undefined ? undefined : `code=${payload.code}`,
    payload?.error,
    payload?.message,
    input.retryAfter ? `retry-after=${input.retryAfter}s` : undefined,
    input.fallbackMessage,
  ].filter(Boolean);

  return redactSecrets(parts.join(' | '));
}

function isSnipeItErrorPayload(value: unknown): value is SnipeItErrorPayload {
  return typeof value === 'object' && value !== null;
}
