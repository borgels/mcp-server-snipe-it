import { afterEach, describe, expect, it, vi } from 'vitest';
import { listEntities } from '../src/snipeit/generic.js';
import { SnipeItClient } from '../src/snipeit/client.js';
import { ENTITIES, ENTITY_NAMES } from '../src/snipeit/entities.js';

const originalEnv = { ...process.env };
afterEach(() => {
  process.env = { ...originalEnv };
});

function recorder() {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ total: 0, rows: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return {
    calls,
    client: new SnipeItClient({ apiToken: 't', baseUrl: 'https://assets.example.com', fetchImpl }),
  };
}

function params(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

describe('list_entities filters', () => {
  it('passes an allowed filter through to the query string', async () => {
    const { client, calls } = recorder();
    await listEntities(client, { entity: 'licenses', filters: { expires: true, company_id: 3 } });
    const q = params(calls[0]!);
    expect(q.get('expires')).toBe('true');
    expect(q.get('company_id')).toBe('3');
    expect(calls[0]).toContain('/api/v1/licenses');
  });

  it('sends booleans as the literal strings Snipe-IT compares against', async () => {
    const { client, calls } = recorder();
    await listEntities(client, { entity: 'licenses', filters: { maintained: false } });
    // The controller tests `input('maintained') == 'false'`, so the string
    // matters — a JS false would serialise to "false" here but an omitted or
    // numeric 0 would not match.
    expect(params(calls[0]!).get('maintained')).toBe('false');
  });

  it('rejects an unknown filter key and names the valid ones', async () => {
    const { client, calls } = recorder();
    await expect(
      listEntities(client, { entity: 'licenses', filters: { expiry_date: '2026-01-01' } }),
    ).rejects.toThrow(/no filter "expiry_date"/);
    // Crucially: nothing was requested, so an unfiltered list cannot be
    // mistaken for a filtered answer.
    expect(calls).toHaveLength(0);
  });

  it('rejects a filter that belongs to a different entity', async () => {
    const { client } = recorder();
    // status_type is valid on statuslabels, not on licenses.
    await expect(listEntities(client, { entity: 'licenses', filters: { status_type: 'x' } })).rejects.toThrow(
      /no filter "status_type"/,
    );
    await expect(listEntities(client, { entity: 'statuslabels', filters: { status_type: 'x' } })).resolves.toBeDefined();
  });

  it('refuses to smuggle pagination through filters', async () => {
    const { client } = recorder();
    for (const key of ['limit', 'offset', 'sort', 'order', 'search']) {
      await expect(
        listEntities(client, { entity: 'users', filters: { [key]: 1 } as Record<string, number> }),
      ).rejects.toThrow();
    }
  });

  it('tells the caller when an entity supports no filters at all', async () => {
    const { client } = recorder();
    await expect(listEntities(client, { entity: 'depreciations', filters: { name: 'x' } })).rejects.toThrow(
      /\(none — use search\)/,
    );
  });

  it('still works with no filters, and keeps the pagination defaults', async () => {
    const { client, calls } = recorder();
    await listEntities(client, { entity: 'users' });
    const q = params(calls[0]!);
    expect(q.get('limit')).toBe('50');
    expect(q.get('offset')).toBe('0');
    expect(q.get('expires')).toBeNull();
  });

  it('every entity declares a filters array, and none of them leak a dedicated argument', () => {
    const reserved = ['search', 'filter', 'limit', 'offset', 'sort', 'order'];
    for (const name of ENTITY_NAMES) {
      const def = ENTITIES[name];
      expect(Array.isArray(def.filters)).toBe(true);
      for (const key of def.filters) {
        expect(reserved).not.toContain(key);
      }
      // No duplicates — they come from a hand transcription of the controllers.
      expect(new Set(def.filters).size).toBe(def.filters.length);
    }
  });

  it('covers the filters that answer the questions people actually ask', () => {
    // Licence compliance.
    expect(ENTITIES.licenses.filters).toContain('expires');
    expect(ENTITIES.licenses.filters).toContain('maintained');
    // Which company owns/pays for a thing — the rebilling axis.
    for (const name of ['licenses', 'accessories', 'consumables', 'components', 'users', 'locations'] as const) {
      expect(ENTITIES[name].filters).toContain('company_id');
    }
    // Maintenance follow-up.
    expect(ENTITIES.maintenances.filters).toContain('asset_id');
    expect(ENTITIES.maintenances.filters).toContain('completed');
  });
});
