import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo, Server } from 'node:net';
import { SnipeItClient } from '../src/snipeit/client.js';
import { CredentialStore } from '../src/snipeit/store.js';
import { createHttpApp } from '../src/transports/http-app.js';
import { getHttpConfig } from '../src/transports/http-helpers.js';

const originalEnv = { ...process.env };
let dir: string;
let open: Server[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'snipeit-enroll-'));
  process.env.SNIPEIT_ENCRYPTION_KEY = 'test-encryption-key-0123456789';
  process.env.SNIPEIT_STORE_PATH = join(dir, 'store.json');
  process.env.SNIPEIT_PER_USER_AUTH = 'true';
  process.env.SNIPEIT_TRUST_FORWARDED_USER = 'true';
  process.env.SNIPEIT_BASE_URL = 'https://assets.example.com';
  delete process.env.SNIPEIT_API_TOKEN;
  delete process.env.MCP_HTTP_TOKEN;
});

afterEach(async () => {
  await Promise.all(open.map(s => new Promise<void>(r => s.close(() => r()))));
  open = [];
  process.env = { ...originalEnv };
  rmSync(dir, { recursive: true, force: true });
});

/** Boots the real request handler on an ephemeral port. */
async function boot(opts: { verify?: (token: string) => unknown; perUser?: boolean } = {}) {
  const store = new CredentialStore();

  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get('authorization') ?? '';
    const token = auth.replace(/^Bearer\s+/, '');
    const result = opts.verify ? opts.verify(token) : { id: 7, username: 'anna' };
    if (result instanceof Error) {
      return new Response(JSON.stringify({ status: 'error', messages: 'Unauthenticated.' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  const enrollClient = new SnipeItClient({ baseUrl: 'https://assets.example.com', fetchImpl });
  const app = createHttpApp({
    config: getHttpConfig(),
    perUser: opts.perUser ?? true,
    store,
    enrollClient,
  });

  const server = createServer(app);
  open.push(server);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, store };
}

function post(base: string, body: Record<string, string>) {
  return fetch(`${base}/snipeit/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
}

describe('/snipeit/enroll', () => {
  it('refuses an unknown or expired state instead of rendering the form', async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/snipeit/enroll?state=not-a-real-state`);
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain('expired');
    expect(body).not.toContain('<form');
  });

  it('renders the form for a valid state without pre-filling any token', async () => {
    const { base, store } = await boot();
    const state = store.createState('anna@example.com');
    const res = await fetch(`${base}/snipeit/enroll?state=${state}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('<form');
    expect(body).toContain('Manage API Keys');
    expect(body).not.toMatch(/value="ey/);
  });

  it('stores the token for the state owner and confirms which account was linked', async () => {
    const { base, store } = await boot({ verify: () => ({ id: 42, username: 'anna' }) });
    const state = store.createState('anna@example.com');

    const res = await post(base, { state, apiToken: 'anna-real-token' });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Linked');
    expect(body).toContain('anna');

    const stored = store.get('anna@example.com');
    expect(stored?.apiToken).toBe('anna-real-token');
    expect(stored?.snipeUserId).toBe(42);
    // The link is spent.
    expect(store.peekState(state)).toBeUndefined();
  });

  it('binds the token to the state owner, not to anything in the request', async () => {
    const { base, store } = await boot();
    const state = store.createState('anna@example.com');
    // A submission naming a different user must not be honoured — identity
    // comes from the state, never from the form.
    await post(base, { state, apiToken: 'anna-real-token', user: 'bo@example.com' });
    expect(store.get('anna@example.com')?.apiToken).toBe('anna-real-token');
    expect(store.get('bo@example.com')).toBeUndefined();
  });

  it('rejects a submission whose state was already consumed (single use)', async () => {
    const { base, store } = await boot();
    const state = store.createState('anna@example.com');
    store.consumeState(state);

    const res = await post(base, { state, apiToken: 'whatever' });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('expired');
    expect(store.get('anna@example.com')).toBeUndefined();
  });

  it('re-renders with an error when no token is pasted, keeping the link usable', async () => {
    const { base, store } = await boot();
    const state = store.createState('anna@example.com');
    const res = await post(base, { state, apiToken: '   ' });
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain('paste your API token');
    expect(body).toContain('<form');
    expect(store.peekState(state)).toBe('anna@example.com');
  });

  it('rejects a token Snipe-IT refuses, and stores nothing', async () => {
    const { base, store } = await boot({ verify: () => new Error('401') });
    const state = store.createState('anna@example.com');

    const res = await post(base, { state, apiToken: 'revoked-token' });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/rejected that token/);
    expect(store.get('anna@example.com')).toBeUndefined();
    // Still recoverable without a new link.
    expect(store.peekState(state)).toBe('anna@example.com');
  });

  it('is absent when per-user mode is off', async () => {
    const { base, store } = await boot({ perUser: false });
    const state = store.createState('anna@example.com');
    const res = await fetch(`${base}/snipeit/enroll?state=${state}`);
    expect(res.status).toBe(404);
  });

  it('healthz reports the auth mode', async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, perUserAuth: true });
  });

  it('refuses /mcp without the gateway bearer when one is configured', async () => {
    process.env.MCP_HTTP_TOKEN = 'gateway-secret';
    const { base } = await boot();
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
