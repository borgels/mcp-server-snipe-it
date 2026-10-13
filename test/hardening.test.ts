import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { SnipeItClient } from '../src/snipeit/client.js';
import { getAsset } from '../src/snipeit/assets.js';
import { safePathSegment } from '../src/snipeit/path.js';
import {
  assertAuthorized,
  assertSafeHttpStartup,
  bearerMatches,
  HttpRequestError,
} from '../src/transports/http-helpers.js';

function req(authorization?: string): IncomingMessage {
  return { headers: authorization === undefined ? {} : { authorization } } as IncomingMessage;
}

const config = { host: '127.0.0.1', port: 0, maxBodyBytes: 1024, httpToken: 'gateway-secret' };

describe('MCP_HTTP_TOKEN comparison', () => {
  it('accepts only the exact bearer', () => {
    expect(() => assertAuthorized(req('Bearer gateway-secret'), config)).not.toThrow();
    for (const bad of [undefined, '', 'Bearer ', 'Bearer gateway-secre', 'Bearer gateway-secretX', 'gateway-secret', 'bearer gateway-secret']) {
      expect(() => assertAuthorized(req(bad), config)).toThrow(HttpRequestError);
    }
  });

  it('compares in constant time over hashed values', () => {
    expect(bearerMatches('Bearer a', 'a')).toBe(true);
    expect(bearerMatches('Bearer ' + 'x'.repeat(10_000), 'a')).toBe(false);
    expect(bearerMatches('Bearer ', '')).toBe(false);
  });
});

describe('HTTP startup guard', () => {
  it('refuses to start when forwarded-user trust is on without MCP_HTTP_TOKEN', () => {
    expect(() => assertSafeHttpStartup({ SNIPEIT_TRUST_FORWARDED_USER: 'true' })).toThrow(/MCP_HTTP_TOKEN/);
    expect(() => assertSafeHttpStartup({ SNIPEIT_TRUST_FORWARDED_USER: 'true', MCP_HTTP_TOKEN: '' })).toThrow();
  });

  it('starts when a token is set or trust is off', () => {
    expect(() => assertSafeHttpStartup({ SNIPEIT_TRUST_FORWARDED_USER: 'true', MCP_HTTP_TOKEN: 's' })).not.toThrow();
    expect(() => assertSafeHttpStartup({})).not.toThrow();
    expect(() => assertSafeHttpStartup({ SNIPEIT_TRUST_FORWARDED_USER: 'false' })).not.toThrow();
  });
});

describe('path-parameter guard', () => {
  it.each(['', '.', '..', 'a/b', 'a\\b', 'a?b', 'a#b', '%2e%2e', '%2E', 'x%2fy', 'x%2Fy', 'x%5cy'])(
    'rejects %j',
    value => {
      expect(() => safePathSegment(value)).toThrow(/Invalid/);
    },
  );

  it('encodes ordinary values', () => {
    expect(safePathSegment('ASSET 001')).toBe('ASSET%20001');
    expect(safePathSegment('a.b-c_d')).toBe('a.b-c_d');
  });

  it('never sends a traversal asset tag or serial upstream', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const client = new SnipeItClient({ baseUrl: 'https://assets.example.com', apiToken: 't', fetchImpl });
    await expect(getAsset(client, { assetTag: '..' })).rejects.toThrow(/Invalid assetTag/);
    await expect(getAsset(client, { serial: '../../users' })).rejects.toThrow(/Invalid serial/);
    expect(fetchImpl).not.toHaveBeenCalled();
    await getAsset(client, { assetTag: 'TAG-1' });
    expect(String((fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0])).toContain(
      '/hardware/bytag/TAG-1',
    );
  });
});
