import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SnipeItClient } from '../src/snipeit/client.js';
import { createServer } from '../src/server.js';
import { SNIPEIT_CAPABILITIES } from '../src/snipeit/capabilities.js';
import { checkout, checkin } from '../src/snipeit/checkouts.js';
import { checkToolPolicy } from '../src/snipeit/policy.js';
import { getEntity } from '../src/snipeit/generic.js';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

function makeClient(record: { calls: Array<{ url: string; body?: unknown }> }): SnipeItClient {
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    record.calls.push({
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify({ status: 'success', messages: 'ok', payload: { id: 1 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return new SnipeItClient({ apiToken: 't', baseUrl: 'https://assets.example.com', fetchImpl });
}

const AUTH_TOOLS = ['snipeit_connect', 'snipeit_status', 'snipeit_disconnect'];

/** Capability ids that name a real tool (guides document workflows instead). */
const toolCapabilityIds = () => SNIPEIT_CAPABILITIES.filter(c => c.kind !== 'guide').map(c => c.id);

async function listToolNames(server: ReturnType<typeof createServer>): Promise<string[]> {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 't', version: '0' });
  await Promise.all([server.connect(st), mcp.connect(ct)]);
  const { tools } = await mcp.listTools();
  return tools.map(t => t.name).sort();
}

describe('MCP tool surface', () => {
  it('registers every capability as a tool with matching annotations', async () => {
    delete process.env.SNIPEIT_PER_USER_AUTH;
    const server = createServer({ client: makeClient({ calls: [] }) });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: 't', version: '0' });
    await Promise.all([server.connect(st), mcp.connect(ct)]);

    const { tools } = await mcp.listTools();
    // Shared-token mode: the catalogue hides the per-user auth tools, and the
    // server does not register them. The two must agree — a tool advertised in
    // discovery but absent from the server is a dead end for the model.
    expect(tools.map(t => t.name).sort()).toEqual(
      toolCapabilityIds()
        .filter(id => !AUTH_TOOLS.includes(id))
        .sort(),
    );
    for (const tool of tools) {
      const cap = SNIPEIT_CAPABILITIES.find(c => c.id === tool.name);
      expect(tool.annotations?.readOnlyHint).toBe(cap?.risk === 'read');
    }
  });

  it('every guide capability documents a workflow, not a phantom tool', async () => {
    process.env.SNIPEIT_PER_USER_AUTH = 'true';
    const registered = new Set(await listToolNames(createServer({ client: makeClient({ calls: [] }) })));
    const guides = SNIPEIT_CAPABILITIES.filter(c => c.kind === 'guide');

    expect(guides.length).toBeGreaterThan(0);
    for (const guide of guides) {
      // A guide must NOT shadow a tool id, or a model will try to call it.
      expect(registered.has(guide.id)).toBe(false);

      // Its steps must name tools that exist, or the guide is a dead end. Read
      // the `tool` field rather than regexing the serialised examples — a
      // custom-field key like "_snipeit_mac_address_1" contains "snipeit_" and
      // is not a tool reference.
      const steps = guide.examples.filter(
        (e): e is { tool: string } => typeof e === 'object' && e !== null && 'tool' in e,
      );
      expect(steps.length).toBeGreaterThan(0);
      for (const step of steps) {
        expect(registered.has(step.tool)).toBe(true);
      }
    }
  });

  it('adds exactly the auth tools in per-user mode, and only there', async () => {
    delete process.env.SNIPEIT_PER_USER_AUTH;
    const shared = await listToolNames(createServer({ client: makeClient({ calls: [] }) }));
    for (const name of AUTH_TOOLS) {
      expect(shared).not.toContain(name);
    }

    process.env.SNIPEIT_PER_USER_AUTH = 'true';
    const perUser = await listToolNames(createServer({ client: makeClient({ calls: [] }) }));
    for (const name of AUTH_TOOLS) {
      expect(perUser).toContain(name);
    }
    // Nothing else changes shape between the two modes.
    expect(perUser.filter(n => !AUTH_TOOLS.includes(n))).toEqual(shared);
    expect(perUser.sort()).toEqual(toolCapabilityIds().sort());
  });
});

describe('policy', () => {
  it('gates write tools on SNIPEIT_ENABLE_WRITES', () => {
    delete process.env.SNIPEIT_ENABLE_WRITES;
    expect(checkToolPolicy('snipeit_list_assets').allowed).toBe(true);
    expect(checkToolPolicy('snipeit_checkout').allowed).toBe(false);
    expect(checkToolPolicy('snipeit_delete_asset').allowed).toBe(false);

    process.env.SNIPEIT_ENABLE_WRITES = 'true';
    expect(checkToolPolicy('snipeit_checkout').allowed).toBe(true);
  });
});

describe('checkout/checkin semantics', () => {
  it('maps each type to the right endpoint and payload', async () => {
    process.env.SNIPEIT_ENABLE_WRITES = 'true';
    const record = { calls: [] as Array<{ url: string; body?: unknown }> };
    const client = makeClient(record);

    await checkout(client, { type: 'asset', id: 1, targetType: 'user', targetId: 9 });
    await checkout(client, { type: 'component', id: 2, targetId: 5, quantity: 3 });
    await checkout(client, { type: 'license', id: 3, targetType: 'user', targetId: 9 });
    await checkin(client, { type: 'license', id: 3, seatId: 44 });
    await checkin(client, { type: 'component', id: 77, quantity: 2 });

    expect(record.calls[0]).toMatchObject({
      url: 'https://assets.example.com/api/v1/hardware/1/checkout',
      body: { checkout_to_type: 'user', assigned_user: 9 },
    });
    expect(record.calls[1]).toMatchObject({
      url: 'https://assets.example.com/api/v1/components/2/checkout',
      body: { assigned_to: 5, assigned_qty: 3 },
    });
    expect(record.calls[2]).toMatchObject({
      url: 'https://assets.example.com/api/v1/licenses/3/checkout',
      body: { target_type: 'user', assigned_to: 9 },
    });
    expect(record.calls[3]).toMatchObject({
      url: 'https://assets.example.com/api/v1/licenses/3/checkin',
      body: { seat_id: 44 },
    });
    expect(record.calls[4]).toMatchObject({
      url: 'https://assets.example.com/api/v1/components/77/checkin',
      body: { checkin_qty: 2 },
    });
  });

  it('rejects invalid combinations before calling the API', async () => {
    process.env.SNIPEIT_ENABLE_WRITES = 'true';
    const client = makeClient({ calls: [] });

    await expect(checkout(client, { type: 'component', id: 1, targetType: 'user', targetId: 2 })).rejects.toThrow(
      'assets',
    );
    await expect(checkin(client, { type: 'license', id: 1 })).rejects.toThrow('seatId');
    await expect(
      checkout(client, { type: 'consumable', id: 1, targetType: 'location', targetId: 2 }),
    ).rejects.toThrow('users');
  });

  it('refuses writes when disabled', async () => {
    delete process.env.SNIPEIT_ENABLE_WRITES;
    const record = { calls: [] as Array<{ url: string; body?: unknown }> };
    const client = makeClient(record);
    await expect(checkout(client, { type: 'asset', id: 1, targetId: 2 })).rejects.toThrow('disabled');
    expect(record.calls).toHaveLength(0);
  });
});

describe('generic entities', () => {
  it('validates include subresources per entity', async () => {
    const record = { calls: [] as Array<{ url: string; body?: unknown }> };
    const client = makeClient(record);

    await getEntity(client, { entity: 'licenses', id: 5, include: 'seats' });
    expect(record.calls[0]?.url).toContain('/licenses/5/seats');

    await expect(getEntity(client, { entity: 'licenses', id: 5, include: 'assets' })).rejects.toThrow(
      'no subresource',
    );
  });
});
