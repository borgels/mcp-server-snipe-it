/**
 * Guard for caller-supplied values that end up as a URL path segment.
 *
 * encodeURIComponent alone is not enough: '.' and '..' pass through unchanged
 * and are resolved as dot-segments by URL parsing, and some upstream stacks
 * decode %2F / %2E before routing. Anything that could change which resource a
 * request addresses is refused before encoding.
 */
export function safePathSegment(value: string, label = 'path parameter'): string {
  if (typeof value !== 'string') {
    throw new Error(`Invalid ${label}: expected a string.`);
  }
  if (value === '' || value === '.' || value === '..') {
    throw new Error(`Invalid ${label}: empty or dot-segment values are not allowed.`);
  }
  if (/[/\\?#]/.test(value) || /%2e|%2f|%5c/i.test(value)) {
    throw new Error(`Invalid ${label}: must not contain '/', '\\', '?', '#', or encoded dots/slashes.`);
  }
  return encodeURIComponent(value);
}
