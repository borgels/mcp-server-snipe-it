import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SnipeItClient } from '../src/snipeit/client.js';
import { CredentialStore } from '../src/snipeit/store.js';
import { createServer } from '../src/server.js';
import { requireUser } from '../src/snipeit/policy.js';

const originalEnv = { ...process.env };
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'snipeit-store-'));
  process.env.SNIPEIT_ENCRYPTION_KEY = 'test-encryption-key-0123456789';
  process.env.SNIPEIT_STORE_PATH = join(dir, 'store.json');
  process.env.SNIPEIT_PER_USER_AUTH = 'true';
  process.env.SNIPEIT_ENABLE_WRITES = 'true';
  process.env.SNIPEIT_PUBLIC_BASE_URL = 'https://snipe-it.example.com';
  process.env.SNIPEIT_BASE_URL = 'https://assets.example.com';
  delete process.env.SNIPEIT_API_TOKEN;
});

afterEach(() => {
  process.env = { ...originalEnv };
  rmSync(dir, { recursive: true, force: true });
});

/** Records the Authorization header of every outbound call. */
function recordingClient(record: string[]): SnipeItClient {
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    record.push(headers.get('authorization') ?? '(none)');
    return new Response(JSON.stringify({ total: 0, rows: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return new SnipeItClient({ baseUrl: 'https://assets.example.com', fetchImpl });
}

async function connect(server: ReturnType<typeof createServer>): Promise<Client> {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 't', version: '0' });
  await Promise.all([server.connect(st), mcp.connect(ct)]);
  return mcp;
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> }).content ?? [];
  return content.map(c => c.text ?? '').join('');
}

describe('per-user credential store', () => {
  it('encrypts at rest — the token never appears in the file', () => {
    const store = new CredentialStore();
    store.set('Anna@Example.com', { apiToken: 'super-secret-token-value', connectedAt: Date.now() });
    const raw = readFileSync(process.env.SNIPEIT_STORE_PATH!, 'utf8');
    expect(raw).not.toContain('super-secret-token-value');
    expect(store.get('anna@example.com')?.apiToken).toBe('super-secret-token-value');
  });

  it('isolates users from each other, case-insensitively', () => {
    const store = new CredentialStore();
    store.set('anna@example.com', { apiToken: 'anna-token', connectedAt: 1 });
    store.set('bo@example.com', { apiToken: 'bo-token', connectedAt: 2 });

    expect(store.get('ANNA@example.com')?.apiToken).toBe('anna-token');
    expect(store.get('bo@example.com')?.apiToken).toBe('bo-token');
    expect(store.get('carl@example.com')).toBeUndefined();

    expect(store.delete('anna@example.com')).toBe(true);
    expect(store.get('anna@example.com')).toBeUndefined();
    // Deleting one user must not touch another's row.
    expect(store.get('bo@example.com')?.apiToken).toBe('bo-token');
  });

  it('binds enrollment state to one user and consumes it exactly once', () => {
    const store = new CredentialStore();
    const state = store.createState('anna@example.com');
    expect(store.peekState(state)).toBe('anna@example.com');
    expect(store.consumeState(state)).toBe('anna@example.com');
    expect(store.consumeState(state)).toBeUndefined(); // single use
    expect(store.peekState('not-a-real-state')).toBeUndefined();
  });

  it('rejects a weak or missing encryption key rather than storing in the clear', () => {
    delete process.env.SNIPEIT_ENCRYPTION_KEY;
    expect(() => new CredentialStore()).toThrow(/SNIPEIT_ENCRYPTION_KEY/);
    process.env.SNIPEIT_ENCRYPTION_KEY = 'short';
    expect(() => new CredentialStore()).toThrow(/SNIPEIT_ENCRYPTION_KEY/);
  });
});

describe('requireUser', () => {
  it('refuses when the gateway forwarded no identity', () => {
    expect(() => requireUser(undefined)).toThrow(/No verified user identity/);
    expect(requireUser('anna@example.com')).toBe('anna@example.com');
  });
});

describe('per-user auth end to end', () => {
  it('sends the CALLER OWN token, not a shared one', async () => {
    const store = new CredentialStore();
    store.set('anna@example.com', { apiToken: 'anna-token', connectedAt: 1 });
    store.set('bo@example.com', { apiToken: 'bo-token', connectedAt: 2 });

    const seen: string[] = [];
    const client = recordingClient(seen);

    const anna = await connect(createServer({ client, store, onBehalfOf: 'anna@example.com' }));
    await anna.callTool({ name: 'snipeit_list_assets', arguments: {} });

    const bo = await connect(createServer({ client, store, onBehalfOf: 'bo@example.com' }));
    await bo.callTool({ name: 'snipeit_list_assets', arguments: {} });

    expect(seen).toEqual(['Bearer anna-token', 'Bearer bo-token']);
  });

  it('refuses data tools for an un-enrolled user instead of falling back', async () => {
    const store = new CredentialStore();
    const seen: string[] = [];
    const mcp = await connect(
      createServer({ client: recordingClient(seen), store, onBehalfOf: 'nobody@example.com' }),
    );

    const result = await mcp.callTool({ name: 'snipeit_list_assets', arguments: {} });
    expect(textOf(result)).toMatch(/NOT_CONNECTED/);
    // The crucial part: no request went out at all, so nothing was done under
    // a borrowed identity.
    expect(seen).toHaveLength(0);
  });

  it('never falls back to SNIPEIT_API_TOKEN even when one is configured', async () => {
    process.env.SNIPEIT_API_TOKEN = 'shared-superuser-token';
    const store = new CredentialStore();
    const seen: string[] = [];
    const mcp = await connect(
      createServer({ client: recordingClient(seen), store, onBehalfOf: 'nobody@example.com' }),
    );

    const result = await mcp.callTool({ name: 'snipeit_list_assets', arguments: {} });
    expect(textOf(result)).toMatch(/NOT_CONNECTED/);
    expect(seen).toHaveLength(0);
    expect(JSON.stringify(seen)).not.toContain('shared-superuser-token');
  });

  it('refuses every data tool when the gateway forwarded no identity', async () => {
    const store = new CredentialStore();
    store.set('anna@example.com', { apiToken: 'anna-token', connectedAt: 1 });
    const seen: string[] = [];
    const mcp = await connect(createServer({ client: recordingClient(seen), store }));

    const result = await mcp.callTool({ name: 'snipeit_list_assets', arguments: {} });
    expect(textOf(result)).toMatch(/No verified user identity/);
    expect(seen).toHaveLength(0);
  });

  it('snipeit_connect mints a single-use link and status reports the linked account', async () => {
    const store = new CredentialStore();
    const mcp = await connect(
      createServer({ client: recordingClient([]), store, onBehalfOf: 'anna@example.com' }),
    );

    const before = await mcp.callTool({ name: 'snipeit_status', arguments: {} });
    expect(textOf(before)).toContain('"connected": false');

    const connectResult = await mcp.callTool({ name: 'snipeit_connect', arguments: {} });
    const payload = JSON.parse(textOf(connectResult)) as { enrollmentUrl: string };
    expect(payload.enrollmentUrl).toMatch(/^https:\/\/snipe-it\.example\.com\/snipeit\/enroll\?state=/);

    const state = new URL(payload.enrollmentUrl).searchParams.get('state')!;
    expect(store.peekState(state)).toBe('anna@example.com');

    store.set('anna@example.com', {
      apiToken: 'anna-token',
      connectedAt: 1_700_000_000_000,
      snipeUserId: 7,
      snipeUsername: 'anna',
    });
    const after = await mcp.callTool({ name: 'snipeit_status', arguments: {} });
    expect(textOf(after)).toContain('"connected": true');
    expect(textOf(after)).toContain('"snipeUsername": "anna"');
    // Status must never leak the token itself.
    expect(textOf(after)).not.toContain('anna-token');
  });

  it('disconnect removes only the caller row', async () => {
    const store = new CredentialStore();
    store.set('anna@example.com', { apiToken: 'anna-token', connectedAt: 1 });
    store.set('bo@example.com', { apiToken: 'bo-token', connectedAt: 2 });

    const mcp = await connect(
      createServer({ client: recordingClient([]), store, onBehalfOf: 'anna@example.com' }),
    );
    const result = await mcp.callTool({ name: 'snipeit_disconnect', arguments: {} });
    expect(textOf(result)).toContain('"disconnected": true');
    expect(store.get('anna@example.com')).toBeUndefined();
    expect(store.get('bo@example.com')?.apiToken).toBe('bo-token');
  });

  it('auth tools work on a read-only instance, so enrollment is always possible', async () => {
    delete process.env.SNIPEIT_ENABLE_WRITES;
    const store = new CredentialStore();
    const mcp = await connect(
      createServer({ client: recordingClient([]), store, onBehalfOf: 'anna@example.com' }),
    );
    const result = await mcp.callTool({ name: 'snipeit_connect', arguments: {} });
    expect(textOf(result)).toContain('enrollmentUrl');
  });
});

describe('verifyToken', () => {
  it('resolves the owner of a token via /users/me with that token', async () => {
    const calls: Array<{ url: string; auth: string | null }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({ url: String(input), auth: headers.get('authorization') });
      return new Response(JSON.stringify({ id: 7, username: 'anna', email: 'anna@example.com' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const client = new SnipeItClient({ baseUrl: 'https://assets.example.com', fetchImpl });
    const identity = await client.verifyToken('anna-token');

    expect(identity).toMatchObject({ id: 7, username: 'anna' });
    expect(calls[0]?.url).toBe('https://assets.example.com/api/v1/users/me');
    // Verification must use the token being enrolled, never the server's own.
    expect(calls[0]?.auth).toBe('Bearer anna-token');
  });
});
