import { describe, expect, it, vi } from 'vitest';
import { SnipeItClient } from '../src/snipeit/client.js';
import { SnipeItHttpError } from '../src/errors.js';

function makeClient(handler: (url: string, init?: RequestInit) => Response | unknown): SnipeItClient {
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const result = handler(String(input), init);
    if (result instanceof Response) {
      return result;
    }
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  return new SnipeItClient({ apiToken: 'tok', baseUrl: 'https://assets.example.com', fetchImpl });
}

describe('SnipeItClient', () => {
  it('appends /api/v1 and sends the Bearer token', async () => {
    let seenUrl = '';
    let auth = '';
    const client = makeClient((url, init) => {
      seenUrl = url;
      auth = (init?.headers as Record<string, string>).Authorization ?? '';
      return { total: 0, rows: [] };
    });

    await client.get('/hardware', { limit: 10, search: 'mac' });
    expect(seenUrl).toBe('https://assets.example.com/api/v1/hardware?limit=10&search=mac');
    expect(auth).toBe('Bearer tok');
  });

  it('throws on HTTP 200 + status:error envelopes (the Snipe-IT quirk)', async () => {
    const client = makeClient(() => ({
      status: 'error',
      messages: { asset_tag: ['The asset tag must be unique.'] },
      payload: null,
    }));

    const error = await client.post('/hardware', {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SnipeItHttpError);
    expect((error as Error).message).toContain('asset_tag');
    expect((error as Error).message).toContain('unique');
  });

  it('passes through list envelopes and success envelopes untouched', async () => {
    const list = makeClient(() => ({ total: 2, rows: [{ id: 1 }, { id: 2 }] }));
    await expect(list.get('/hardware')).resolves.toMatchObject({ total: 2 });

    const success = makeClient(() => ({ status: 'success', messages: 'Asset updated', payload: { id: 1 } }));
    await expect(success.patch('/hardware/1', {})).resolves.toMatchObject({ status: 'success' });
  });

  it('surfaces 429 throttling with retry-after', async () => {
    const client = makeClient(
      () =>
        new Response(JSON.stringify({ status: 'error', messages: 'Too many requests.' }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '30' },
        }),
    );

    const error = await client.get('/hardware').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SnipeItHttpError);
    expect((error as SnipeItHttpError).status).toBe(429);
    expect((error as SnipeItHttpError).retryAfter).toBe('30');
  });

  it('requires https and a configured base URL', () => {
    expect(() => new SnipeItClient({ apiToken: 't', baseUrl: 'http://assets.example.com' })).toThrow('https://');
    delete process.env.SNIPEIT_BASE_URL;
    expect(() => new SnipeItClient({ apiToken: 't' })).toThrow('SNIPEIT_BASE_URL');
  });
});
