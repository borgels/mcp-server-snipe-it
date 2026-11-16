import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SnipeItClient } from '../src/snipeit/client.js';
import { PACKAGE_VERSION } from '../src/version.js';

const TOKEN = 'snipeit-test-token-0123456789';

function client(fetchImpl: typeof fetch): SnipeItClient {
  return new SnipeItClient({ apiToken: TOKEN, baseUrl: 'https://assets.example.com', fetchImpl });
}

const originalEnv = { ...process.env };
afterEach(() => {
  process.env = { ...originalEnv };
});

describe('Snipe-IT client hardening', () => {
  it('never follows redirects, so the token stays on the API origin', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe('manual');
      return new Response(null, { status: 308, headers: { location: 'https://elsewhere.example/x' } });
    });
    await expect(client(fetchImpl as typeof fetch).get('/hardware')).rejects.toThrow(
      /redirect \(HTTP 308\).*redirects are not followed/,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('redacts the token before truncating error text and caps the error body', async () => {
    const body = JSON.stringify({ message: `${'x'.repeat(490)} ${TOKEN} ${'y'.repeat(5_000)}` });
    const fetchImpl = vi.fn(async () => new Response(body, { status: 422 }));
    const error: Error = await client(fetchImpl as typeof fetch)
      .get('/users', { search: 'secret@example.com' })
      .then(
        () => {
          throw new Error('expected failure');
        },
        (e: unknown) => e as Error & { url: string },
      );
    expect((error as Error & { url: string }).url).not.toContain('secret@example.com');
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).not.toContain(TOKEN.slice(0, 12));
    expect(error.message).not.toContain('secret@example.com');
    expect(error.message.length).toBeLessThan(2_000);

    const huge = vi.fn(async () => new Response('z'.repeat(1_000_000), { status: 500 }));
    const hugeError: Error & { payload: unknown } = await client(huge as typeof fetch)
      .get('/hardware')
      .then(
        () => {
          throw new Error('expected failure');
        },
        (e: unknown) => e as Error & { payload: unknown },
      );
    expect(String(hugeError.payload).length).toBeLessThanOrEqual(64 * 1024);
  });

  it('redacts per-user tokens cloned with withToken', async () => {
    const userToken = 'per-user-token-abcdefghijklmnop';
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ message: `echo ${userToken}` }), { status: 400 }),
    );
    const message = await client(fetchImpl as typeof fetch)
      .withToken(userToken)
      .get('/hardware')
      .then(
        () => 'resolved',
        (e: unknown) => (e as Error).message,
      );
    expect(message).not.toContain(userToken);
  });

  it('rejects an invalid SNIPEIT_TIMEOUT_MS instead of using NaN', () => {
    process.env.SNIPEIT_BASE_URL = 'https://assets.example.com';
    process.env.SNIPEIT_TIMEOUT_MS = 'abc';
    expect(() => new SnipeItClient()).toThrow(/SNIPEIT_TIMEOUT_MS/);
    process.env.SNIPEIT_TIMEOUT_MS = '5000';
    expect(() => new SnipeItClient()).not.toThrow();
  });

  it('reports the package version', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(PACKAGE_VERSION).toBe(pkg.version);
  });
});
