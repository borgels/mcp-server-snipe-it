import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ADDRESS_REFUSED,
  createSnipeItGateway,
  GatewayConfigError,
  KEY_REFUSED,
  normalizeSnipeItBaseUrl,
  PRIVATE_ADDRESS_REFUSED,
  snipeItGatewayTools,
  snipeItToolCatalog,
  type GatewayJsonObject,
  type SnipeItGatewayOptions,
} from '../src/gateway.js';
import { admitsKey } from '../src/key-admission.js';
import { callerPseudonym } from '../src/snipeit/audit.js';
import { SNIPEIT_REFUSED } from '../src/snipeit/client.js';

const TOKEN_A = 'qqqqwwwwzzzzxxxx1';
const TOKEN_B = 'jjjjkkkkvvvvyyyy2';
const BASE = 'https://assets.example.com';
const PUBLIC_IP = '93.184.216.34'; // A public unicast test address, never contacted. hygiene:allow
const resolveHost = vi.fn(async () => [PUBLIC_IP]);

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'snipeit-gateway-'));
  vi.unstubAllEnvs();
  resolveHost.mockClear();
  // The MCP server's variables, set as a shared process would have them: an embedded instance must ignore them all.
  vi.stubEnv('SNIPEIT_API_TOKEN', 'env-token-must-not-be-used-0000');
  vi.stubEnv('SNIPEIT_BASE_URL', 'https://env-base.example.org');
  // Not a number: an instance that read it would throw.
  vi.stubEnv('SNIPEIT_TIMEOUT_MS', 'not-a-number');
  vi.stubEnv('SNIPEIT_ENABLE_WRITES', 'true');
  vi.stubEnv('SNIPEIT_AUDIT_LOG', join(dir, 'audit.log'));
  vi.stubEnv('SNIPEIT_PER_USER_AUTH', 'true');
  vi.stubEnv('SNIPEIT_TRUST_FORWARDED_USER', 'true');
  vi.stubEnv('SNIPEIT_PUBLIC_BASE_URL', 'https://env-public.example.org');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function jsonResponse(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** The request's method and path. */
function requestOf(url: unknown, init: RequestInit | undefined): string {
  return `${init?.method ?? 'GET'} ${decodeURIComponent(new URL(String(url)).pathname)}`;
}

const ROW = { id: 7, name: 'Laptop 7', asset_tag: 'LAP-0007' };
const DATA = { total: 1, rows: [ROW], id: 7, name: 'Laptop 7', status: 'success', messages: 'OK', payload: { id: 7 } };

/** A Snipe-IT that answers every request with `data`. */
function snipeit(data: unknown = DATA) {
  return vi.fn<typeof fetch>(async () => jsonResponse(data));
}

function sink() {
  const records: Array<Record<string, unknown>> = [];
  return { records, audit: (record: Readonly<Record<string, unknown>>) => void records.push({ ...record }) };
}

function gateway(fetchImpl: typeof fetch, extra: Partial<SnipeItGatewayOptions> = {}) {
  return createSnipeItGateway({ apiToken: TOKEN_A, baseUrl: BASE, fetchImpl, resolveHost, ...extra });
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>;
}

function matches(template: string, path: string): boolean {
  const pattern = template
    .split('/')
    .map(segment => (/^\{[^}]+\}$/.test(segment) ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return new RegExp(`^${pattern}$`).test(path);
}

/** A valid minimal input per gateway tool. */
const MINIMAL_INPUT: Record<string, GatewayJsonObject> = {
  search_capabilities: {},
  check_connection: {},
  list_assets: {},
  get_asset: { assetId: 7 },
  list_licenses: {},
  get_license: { licenseId: 3 },
  list_accessories: {},
  list_consumables: {},
  list_components: {},
  list_users: {},
  list_locations: {},
  list_reference_data: { kind: 'models' },
  get_activity_report: {},
  create_asset: { modelId: 4, statusId: 2, assetTag: 'LAP-0100' },
  update_asset: { assetId: 7, notes: 'Skærm revnet.' },
  checkout_asset: { assetId: 7, targetId: 12 },
  checkin_asset: { assetId: 7 },
  audit_asset: { assetId: 7 },
  checkout_license_seat: { licenseId: 3, seatId: 17, targetId: 12 },
  checkin_license_seat: { licenseId: 3, seatId: 17 },
};

/** Further inputs that reach every declared request. */
const MORE_INPUTS: Array<[string, GatewayJsonObject]> = [
  ['list_assets', { due: 'audits-overdue' }],
  ['list_assets', { due: 'checkins-due' }],
  ['get_asset', { assetTag: 'LAP-0007' }],
  ['get_asset', { serial: 'C02XK1ABJGH5' }],
  ['get_license', { licenseId: 3, includeSeats: true }],
  ['list_users', { userId: 12 }],
  ['list_reference_data', { kind: 'categories' }],
  ['list_reference_data', { kind: 'manufacturers' }],
  ['list_reference_data', { kind: 'statuslabels' }],
  ['list_reference_data', { kind: 'suppliers' }],
  ['list_reference_data', { kind: 'departments' }],
];

const WRITES = [
  'create_asset',
  'update_asset',
  'checkout_asset',
  'checkin_asset',
  'audit_asset',
  'checkout_license_seat',
  'checkin_license_seat',
];

describe('Snipe-IT gateway surface', () => {
  it('uses test credentials the gateway admits', () => {
    expect(admitsKey(TOKEN_A)).toBe(true);
    expect(admitsKey(TOKEN_B)).toBe(true);
  });

  it('admits a key shaped like a Snipe-IT personal API key (a JSON Web Token) and sends it whole', async () => {
    const segment = (text: string) => Buffer.from(text).toString('base64url');
    let seed = 7;
    const random = Array.from({ length: 342 }, () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[seed % 64];
    }).join('');
    const key = [
      segment('{"typ":"JWT","alg":"RS256"}'),
      segment('{"aud":"1","jti":"5f0c2a9e7d","iat":1763600000,"nbf":1763600000,"exp":1795136000,"sub":"12","scopes":[]}'),
      random,
    ].join('.');
    expect(admitsKey(key)).toBe(true);
    const fetchImpl = snipeit({ id: 12, name: 'IT', username: 'it', email: 'it@example.com' });
    const result = await createSnipeItGateway({ apiToken: key, baseUrl: BASE, fetchImpl, resolveHost }).callTool('check_connection', {});
    expect(result.structuredContent).toEqual({ connected: true, user: { id: 12, name: 'IT', username: 'it', email: 'it@example.com' } });
    expect(headersOf(fetchImpl.mock.calls[0]![1]).Authorization).toBe(`Bearer ${key}`);
  });

  it('has the agreed tool set: reads enabled by default, writes not, nothing broad, no delete', () => {
    expect(snipeItToolCatalog.map(tool => [tool.name, tool.riskLevel, tool.enabledByDefault, tool.broad])).toEqual([
      ['search_capabilities', 'read', true, false],
      ['check_connection', 'read', true, false],
      ['list_assets', 'read', true, false],
      ['get_asset', 'read', true, false],
      ['list_licenses', 'read', true, false],
      ['get_license', 'read', true, false],
      ['list_accessories', 'read', true, false],
      ['list_consumables', 'read', true, false],
      ['list_components', 'read', true, false],
      ['list_users', 'read', true, false],
      ['list_locations', 'read', true, false],
      ['list_reference_data', 'read', true, false],
      ['get_activity_report', 'read', true, false],
      ['create_asset', 'write', false, false],
      ['update_asset', 'write', false, false],
      ['checkout_asset', 'write', false, false],
      ['checkin_asset', 'write', false, false],
      ['audit_asset', 'write', false, false],
      ['checkout_license_seat', 'write', false, false],
      ['checkin_license_seat', 'write', false, false],
    ]);
    expect(Object.keys(MINIMAL_INPUT).sort()).toEqual(snipeItToolCatalog.map(tool => tool.name).sort());
    for (const tool of snipeItToolCatalog) {
      expect(tool.name.startsWith('snipeit_')).toBe(false);
      expect(tool.upstream.every(operation => operation.method !== ('DELETE' as never))).toBe(true);
      expect(tool.upstream.every(operation => operation.method !== ('PUT' as never))).toBe(true);
    }
    // The MCP server's generic and enrollment tools are not in the gateway.
    const names = snipeItToolCatalog.map(tool => tool.name);
    for (const name of ['list_entities', 'get_entity', 'create_entity', 'update_entity', 'checkout', 'checkin', 'connect', 'status', 'disconnect']) {
      expect(names).not.toContain(name);
    }
  });

  it('has a deeply frozen catalog equal to the tool definitions, with strict input schemas', () => {
    expect(Object.isFrozen(snipeItToolCatalog)).toBe(true);
    for (const entry of snipeItToolCatalog) {
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Object.isFrozen(entry.inputSchema)).toBe(true);
      expect(Object.isFrozen(entry.upstream)).toBe(true);
      for (const operation of entry.upstream) {
        expect(Object.isFrozen(operation)).toBe(true);
        expect(operation.path.startsWith('/api/v1/')).toBe(true);
      }
      expect(entry.inputSchema.type).toBe('object');
      expect(entry.inputSchema.additionalProperties).toBe(false);
      const { upstream: _upstream, broad: _broad, ...definition } = entry;
      expect(snipeItGatewayTools.find(tool => tool.name === entry.name)).toEqual(definition);
    }
    expect(() => {
      (snipeItToolCatalog[0] as { name: string }).name = 'changed';
    }).toThrow();
  });

  it('lists the input fields of each tool, and takes no free-form payload', () => {
    const fields = Object.fromEntries(
      snipeItToolCatalog.map(tool => [tool.name, Object.keys((tool.inputSchema.properties ?? {}) as object)]),
    );
    expect(fields.get_asset).toEqual(['assetId', 'assetTag', 'serial']);
    expect(fields.update_asset).toEqual([
      'assetId',
      'name',
      'statusId',
      'locationId',
      'defaultLocationId',
      'notes',
      'orderNumber',
      'purchaseDate',
      'warrantyMonths',
    ]);
    expect(fields.checkout_asset).toEqual(['assetId', 'targetType', 'targetId', 'expectedCheckin', 'statusId', 'note']);
    expect(fields.checkout_license_seat).toEqual(['licenseId', 'seatId', 'targetType', 'targetId', 'note']);
    expect(fields.list_reference_data).toEqual(['kind', 'search', 'limit', 'offset']);
    for (const tool of snipeItToolCatalog) {
      expect(fields[tool.name]).not.toContain('payload');
      expect(fields[tool.name]).not.toContain('patch');
      expect(fields[tool.name]).not.toContain('path');
      expect(fields[tool.name]).not.toContain('filters');
    }
  });
});

describe('Snipe-IT gateway upstream requests', () => {
  it('sends only the requests the catalog declares for each tool, and reaches each of them', async () => {
    const reached = new Set<string>();
    for (const [name, input] of [...Object.entries(MINIMAL_INPUT), ...MORE_INPUTS]) {
      const fetchImpl = snipeit();
      const result = await gateway(fetchImpl, { policy: { enableWrites: true } }).callTool(name, input);
      expect(result.isError, `${name}: ${result.content[0]?.text}`).toBeUndefined();
      const declared = snipeItToolCatalog.find(tool => tool.name === name)!.upstream;
      for (const [url, init] of fetchImpl.mock.calls) {
        expect(String(url).startsWith(`${BASE}/api/v1/`)).toBe(true);
        const [method, path] = requestOf(url, init).split(' ');
        const hit = declared.find(operation => operation.method === method && matches(operation.path, path!));
        expect(hit, `${name}: ${method} ${path}`).toBeDefined();
        reached.add(`${name} ${hit!.method} ${hit!.path}`);
      }
    }
    for (const tool of snipeItToolCatalog) {
      for (const operation of tool.upstream) {
        expect(reached.has(`${tool.name} ${operation.method} ${operation.path}`), `${tool.name} ${operation.path}`).toBe(true);
      }
    }
  });

  it('sends only the allowlisted asset fields, by PATCH', async () => {
    const fetchImpl = snipeit();
    await gateway(fetchImpl, { policy: { enableWrites: true } }).callTool('update_asset', {
      assetId: 7,
      statusId: 3,
      defaultLocationId: 2,
      purchaseDate: '2026-01-31',
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(requestOf(url, init)).toBe('PATCH /api/v1/hardware/7');
    expect(JSON.parse(String(init?.body))).toEqual({ status_id: 3, rtd_location_id: 2, purchase_date: '2026-01-31' });
  });

  it('checks an asset out to a location, and a license seat to an asset', async () => {
    const fetchImpl = snipeit();
    const g = gateway(fetchImpl, { policy: { enableWrites: true } });
    await g.callTool('checkout_asset', { assetId: 7, targetType: 'location', targetId: 5, note: 'Lager' });
    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body))).toEqual({ checkout_to_type: 'location', assigned_location: 5, note: 'Lager' });
    await g.callTool('checkout_license_seat', { licenseId: 3, seatId: 17, targetType: 'asset', targetId: 7 });
    expect(requestOf(...fetchImpl.mock.calls[1]!)).toBe('GET /api/v1/licenses/3/seats/17');
    expect(JSON.parse(String(fetchImpl.mock.calls[2]![1]?.body))).toEqual({ asset_id: 7 });
    await g.callTool('checkin_license_seat', { licenseId: 3, seatId: 17 });
    expect(JSON.parse(String(fetchImpl.mock.calls[3]![1]?.body))).toEqual({ assigned_to: null, asset_id: null });
  });

  it('refuses to assign a seat that is taken, so a user and an asset never share one', async () => {
    for (const holder of [{ assigned_user: { id: 12, name: 'Mette' } }, { assigned_asset: { id: 7, name: 'Laptop 7' } }]) {
      const fetchImpl = snipeit({ id: 17, license_id: 3, ...holder });
      const result = await gateway(fetchImpl, { policy: { enableWrites: true } }).callTool('checkout_license_seat', {
        licenseId: 3,
        seatId: 17,
        targetType: 'asset',
        targetId: 8,
      });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toMatch(/^The seat is taken\./);
      expect(fetchImpl.mock.calls.map(([url, init]) => requestOf(url, init))).toEqual(['GET /api/v1/licenses/3/seats/17']);
    }
  });

  it('refuses an activity filter given as type or id alone, which Snipe-IT would ignore', async () => {
    const fetchImpl = snipeit();
    for (const [input, text] of [
      [{ itemType: 'license' }, 'Give itemType and itemId together, or neither.'],
      [{ itemId: 3 }, 'Give itemType and itemId together, or neither.'],
      [{ targetType: 'user' }, 'Give targetType and targetId together, or neither.'],
      [{ targetId: 12 }, 'Give targetType and targetId together, or neither.'],
    ] as Array<[GatewayJsonObject, string]>) {
      const result = await gateway(fetchImpl).callTool('get_activity_report', input);
      expect(result.content[0]!.text).toBe(text);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await gateway(fetchImpl).callTool('get_activity_report', { itemType: 'license', itemId: 3 })).isError).toBeUndefined();
    const url = new URL(String(fetchImpl.mock.calls[0]![0]));
    expect([url.searchParams.get('item_type'), url.searchParams.get('item_id')]).toEqual(['license', '3']);
  });

  it('filters assets by assignee with Snipe-IT’s own type names, and caps the page size', async () => {
    const fetchImpl = snipeit();
    await gateway(fetchImpl).callTool('list_assets', { assignedTo: 12, status: 'Deployed', limit: 100 });
    const url = new URL(String(fetchImpl.mock.calls[0]![0]));
    expect(url.searchParams.get('assigned_to')).toBe('12');
    expect(url.searchParams.get('assigned_type')).toBe('App\\Models\\User');
    expect(url.searchParams.get('status')).toBe('Deployed');
    expect(url.searchParams.get('limit')).toBe('100');
    const tooMany = await gateway(fetchImpl).callTool('list_assets', { limit: 500 });
    expect(tooMany.isError).toBe(true);
  });

  it('refuses a get_asset without exactly one identifier, before anything is sent', async () => {
    const fetchImpl = snipeit();
    for (const input of [{}, { assetId: 7, assetTag: 'LAP-0007' }] as GatewayJsonObject[]) {
      const result = await gateway(fetchImpl).callTool('get_asset', input);
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toBe('Give exactly one of assetId, assetTag or serial.');
    }
    const dots = await gateway(fetchImpl).callTool('get_asset', { assetTag: '..' });
    expect(dots.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('lists only what the instance offers in search_capabilities', async () => {
    const result = await gateway(snipeit(), { policy: { disabledTools: ['checkout_asset'] } }).callTool('search_capabilities', {
      limit: 50,
    });
    const ids = (result.structuredContent as Array<{ id: string }>).map(entry => entry.id);
    expect(ids).toContain('snipeit_checkin_asset');
    expect(ids).toContain('snipeit_check_connection');
    expect(ids).not.toContain('snipeit_checkout_asset');
    for (const id of ['snipeit_list_entities', 'snipeit_get_entity', 'snipeit_create_entity', 'snipeit_connect', 'snipeit_checkout']) {
      expect(ids).not.toContain(id);
    }
  });
});

describe('Snipe-IT gateway secrets in answers', () => {
  it('never returns a license product key, in a list, a license, its seats or a seat change', async () => {
    const productCode = 'XKCD7-PRODK-EYQQQ-ZZZZ9-ABCDE';
    const license = {
      id: 3,
      name: 'Office',
      product_key: productCode,
      serial: productCode,
      license_name: 'Demo Firma',
      seats: 10,
      free_seats_count: 4,
      manufacturer: { id: 2, name: 'Vendor', url: 'https://vendor.example.com' },
    };
    const seat = { id: 17, license_id: 3, name: 'Seat 1', serial: productCode, license: { serial: productCode }, assigned_user: { id: 12, name: 'Mette', email: 'mette@example.com', phone: '12345678' } };
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      const request = requestOf(url, init);
      if (request === 'GET /api/v1/licenses') return jsonResponse({ total: 1, rows: [license] });
      if (request === 'GET /api/v1/licenses/3') return jsonResponse(license);
      if (request === 'GET /api/v1/licenses/3/seats') return jsonResponse({ total: 1, rows: [seat] });
      return jsonResponse({ status: 'success', messages: 'Seat updated', payload: { ...seat, license_key: productCode, product_key: productCode } });
    });
    const g = gateway(fetchImpl, { policy: { enableWrites: true } });
    const results = [
      await g.callTool('list_licenses', {}),
      await g.callTool('get_license', { licenseId: 3, includeSeats: true }),
      await g.callTool('checkout_license_seat', { licenseId: 3, seatId: 17, targetId: 12 }),
    ];
    for (const result of results) {
      expect(result.isError).toBeUndefined();
      const text = JSON.stringify(result);
      expect(text).not.toContain(productCode);
      expect(text).not.toContain('XKCD7');
      expect(text).not.toMatch(/product_key|"serial"|license_key/);
    }
    expect(results[1]!.structuredContent).toMatchObject({
      license: { id: 3, name: 'Office', seats: 10, free_seats_count: 4, manufacturer: { id: 2, name: 'Vendor' } },
      seats: { total: 1, rows: [{ id: 17, assigned_user: { id: 12, name: 'Mette', email: 'mette@example.com' } }] },
    });
    expect(JSON.stringify(results[1])).not.toContain('12345678');
  });

  it('returns only name, user name, mail, department, location and counts of a user', async () => {
    const user = {
      id: 12,
      name: 'Mette Jensen',
      username: 'mette',
      email: 'mette@example.com',
      phone: '12345678',
      address: 'Eksempelvej 1',
      employee_num: 'E-991',
      permissions: { superuser: '1' },
      department: { id: 2, name: 'Økonomi' },
      location: { id: 5, name: 'Kontor' },
      assets_count: 2,
      licenses_count: 1,
    };
    const result = await gateway(snipeit({ total: 1, rows: [user] })).callTool('list_users', { search: 'mette' });
    expect(result.structuredContent).toEqual({
      total: 1,
      rows: [
        {
          id: 12,
          name: 'Mette Jensen',
          username: 'mette',
          email: 'mette@example.com',
          department: { id: 2, name: 'Økonomi' },
          location: { id: 5, name: 'Kontor' },
          assets_count: 2,
          licenses_count: 1,
        },
      ],
    });
  });

  it('leaves out custom fields of assets and change details and addresses of the activity log', async () => {
    const asset = {
      id: 7,
      asset_tag: 'LAP-0007',
      serial: 'C02XK1ABJGH5',
      custom_fields: { 'BitLocker key': { field: '_snipeit_bitlocker_1', value: '111111-222222-333333' } },
      status_label: { id: 2, name: 'Ready', status_meta: 'deployable', status_type: 'deployable' },
      assigned_to: { id: 12, name: 'Mette', username: 'mette', email: 'mette@example.com', employee_number: 'E-991', type: 'user' },
    };
    const assetResult = await gateway(snipeit(asset)).callTool('get_asset', { assetId: 7 });
    expect(assetResult.structuredContent).toEqual({
      asset: {
        id: 7,
        asset_tag: 'LAP-0007',
        serial: 'C02XK1ABJGH5',
        status_label: { id: 2, name: 'Ready', status_type: 'deployable', status_meta: 'deployable' },
        assigned_to: { id: 12, name: 'Mette', type: 'user', username: 'mette', email: 'mette@example.com' },
      },
    });
    const entry = {
      id: 1,
      action_type: 'update',
      item: { id: 3, name: 'Office', type: 'license', serial: 'XKCD7-PRODK' },
      log_meta: { serial: { old: 'XKCD7-PRODK', new: 'XKCD7-PRODL' } },
      remote_ip: '198.51.100.4',
      user_agent: 'Mozilla',
    };
    const activity = await gateway(snipeit({ total: 1, rows: [entry] })).callTool('get_activity_report', {});
    expect(activity.structuredContent).toEqual({ total: 1, rows: [{ id: 1, action_type: 'update', item: { id: 3, name: 'Office', type: 'license' } }] });
  });
});

describe('Snipe-IT gateway connection settings', () => {
  it('uses only the key and address it was given, never SNIPEIT_*', async () => {
    const fetchImpl = snipeit();
    const g = createSnipeItGateway({
      apiToken: TOKEN_A,
      baseUrl: `${BASE}/`,
      fetchImpl,
      resolveHost,
      // Not gateway options: dropped.
      ...({ onBehalfOf: 'someone@example.com', store: {} } as object),
    } as SnipeItGatewayOptions);
    for (const [name, input] of Object.entries(MINIMAL_INPUT)) await g.callTool(name, input);
    expect(fetchImpl).toHaveBeenCalled();
    for (const [url, init] of fetchImpl.mock.calls) {
      expect(String(url).startsWith(`${BASE}/api/v1/`)).toBe(true);
      const headers = headersOf(init);
      expect(headers.Authorization).toBe(`Bearer ${TOKEN_A}`);
      expect(Object.keys(headers).map(key => key.toLowerCase())).not.toContain('x-mcp-user');
    }
    // SNIPEIT_ENABLE_WRITES=true is set, but the host gave no policy: no writes.
    expect(fetchImpl.mock.calls.every(([, init]) => (init?.method ?? 'GET') === 'GET')).toBe(true);
    // SNIPEIT_PER_USER_AUTH=true is set, but the gateway has no enrollment: calls run with the given key.
    expect((await g.callTool('check_connection', {})).isError).toBeUndefined();
    expect(existsSync(join(dir, 'audit.log'))).toBe(false);
  });

  it('requires the key and the address', () => {
    expect(() => createSnipeItGateway({ baseUrl: BASE } as SnipeItGatewayOptions)).toThrow(/requires options.apiToken/);
    expect(() => createSnipeItGateway({ apiToken: TOKEN_A } as SnipeItGatewayOptions)).toThrow(ADDRESS_REFUSED);
    expect(() => createSnipeItGateway(undefined as never)).toThrow(GatewayConfigError);
  });

  it('refuses a short key or one that shares text with our own texts, without quoting it', () => {
    for (const apiToken of ['short-token', 'Snipe-IT API request failed with HTTP']) {
      let error: unknown;
      try {
        createSnipeItGateway({ apiToken, baseUrl: BASE });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(GatewayConfigError);
      expect((error as Error).message).toContain('options.apiToken');
      expect((error as Error).message).not.toContain(apiToken);
      expect((error as Error).stack).not.toMatch(/\n\s+at /);
    }
    expect(KEY_REFUSED).toMatch(/refused/);
  });

  it('normalises an accepted address', () => {
    expect(normalizeSnipeItBaseUrl('https://Assets.Example.com')).toBe('https://assets.example.com');
    expect(normalizeSnipeItBaseUrl(' https://assets.example.com/ ')).toBe('https://assets.example.com');
    expect(normalizeSnipeItBaseUrl('https://assets.example.com.')).toBe('https://assets.example.com');
    expect(normalizeSnipeItBaseUrl('https://demo-firma.snipe-it.io')).toBe('https://demo-firma.snipe-it.io');
  });

  it('refuses an address that is not https to a public host name, without quoting it', () => {
    const refused = [
      'http://assets.example.com',
      'ftp://assets.example.com',
      'https://user:pass@assets.example.com',
      'https://user@assets.example.com',
      'https://assets.example.com/api/v1',
      'https://assets.example.com/snipeit',
      'https://assets.example.com?x=1',
      'https://assets.example.com/#frag',
      'https://assets.example.com:8443',
      'https://localhost',
      'https://127.0.0.1',
      'https://10.0.0.5',
      'https://169.254.169.254',
      'https://[::1]',
      'https://[fd00::1]',
      'https://2130706433',
      'https://0x7f000001',
      'https://intranet',
      'https://snipeit.local',
      'https://snipeit.internal',
      'https://metadata.google.internal',
      'assets.example.com',
      '',
      42,
    ];
    for (const value of refused) {
      let error: unknown;
      try {
        normalizeSnipeItBaseUrl(value);
      } catch (caught) {
        error = caught;
      }
      expect(error, String(value)).toBeInstanceOf(GatewayConfigError);
      expect((error as Error).message.startsWith(ADDRESS_REFUSED), String(value)).toBe(true);
      if (typeof value === 'string' && value) expect((error as Error).message).not.toContain(value);
      expect(() => createSnipeItGateway({ apiToken: TOKEN_A, baseUrl: value as string }), String(value)).toThrow(ADDRESS_REFUSED);
    }
  });

  it('refuses at the first call when the name points to a private address, before anything is sent', async () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '::1', '::ffff:127.0.0.1', 'fd00::5', '100.64.0.1']) {
      const fetchImpl = snipeit();
      const g = gateway(fetchImpl, { resolveHost: async () => [PUBLIC_IP, address] });
      const result = await g.callTool('check_connection', {});
      expect(result.isError, address).toBe(true);
      expect(result.content[0]!.text).toBe(PRIVATE_ADDRESS_REFUSED);
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it('refuses a private address with the built-in fetch too, checked by the connection itself', async () => {
    const g = createSnipeItGateway({ apiToken: TOKEN_A, baseUrl: BASE, resolveHost: async () => ['127.0.0.1'] });
    const result = await g.callTool('check_connection', {});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe(PRIVATE_ADDRESS_REFUSED);
  });

  it('words a name that does not resolve as a network error', async () => {
    const g = gateway(snipeit(), {
      resolveHost: async () => {
        throw new Error('getaddrinfo ENOTFOUND assets.example.com');
      },
    });
    const result = await g.callTool('check_connection', {});
    expect(result.content[0]!.text).toBe('Network error calling the Snipe-IT API (GET) (ENOTFOUND).');
  });

  it('never follows a redirect, and does not quote the address or the Location', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init?.redirect).toBe('manual');
      return new Response(null, { status: 302, headers: { location: 'https://elsewhere.example.org/steal' } });
    });
    const result = await gateway(fetchImpl).callTool('check_connection', {});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/^Snipe-IT API responded with a redirect \(HTTP 302\) for GET; redirects are not followed/);
    expect(result.content[0]!.text).not.toContain('elsewhere');
    expect(result.content[0]!.text).not.toContain('assets.example.com');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('uses 30 seconds as time limit, or the host’s, and words a timeout itself', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      await new Promise((resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)));
      return jsonResponse({});
    });
    const result = await gateway(fetchImpl, { timeoutMs: 20 }).callTool('check_connection', {});
    expect(result.content[0]!.text).toBe('Snipe-IT API request timed out after 20 ms (GET).');
  });
});

describe('Snipe-IT gateway input', () => {
  it('validates input with the tool schema before anything is sent, and refuses unknown fields', async () => {
    const fetchImpl = snipeit();
    const g = gateway(fetchImpl, { policy: { enableWrites: true } });
    for (const [name, input] of [
      ['get_license', {}],
      ['get_license', { licenseId: -1 }],
      ['get_license', { licenseId: 3, extra: true }],
      ['list_reference_data', { kind: 'groups' }],
      ['list_reference_data', { kind: 'users' }],
      ['create_asset', { modelId: 4 }],
      ['create_asset', { modelId: 4, statusId: 2, payload: { asset_tag: 'x' } }],
      ['update_asset', { assetId: 7, asset_tag: '' }],
      ['update_asset', { assetId: 7, purchaseDate: '31-01-2026' }],
      ['update_asset', { assetId: 7, _snipeit_bitlocker_1: 'x' }],
      ['checkout_license_seat', { licenseId: 3, seatId: 17, targetType: 'location', targetId: 5 }],
    ] as Array<[string, GatewayJsonObject]>) {
      const result = await g.callTool(name, input);
      expect(result.isError, `${name} ${JSON.stringify(input)}`).toBe(true);
      expect(result.content[0]!.text).toMatch(new RegExp(`^Invalid input for ${name}:`));
    }
    const empty = await g.callTool('update_asset', { assetId: 7 });
    expect(empty.content[0]!.text).toBe('Give at least one field to change.');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses unknown tools and the MCP server tools outside the gateway, and accepts the prefix', async () => {
    const fetchImpl = snipeit();
    const g = gateway(fetchImpl, { policy: { enableWrites: true } });
    for (const name of [
      'list_entities',
      'get_entity',
      'create_entity',
      'update_entity',
      'checkout',
      'checkin',
      'connect',
      'status',
      'disconnect',
      'delete_asset',
      'snipeit_list_entities',
    ]) {
      const result = await g.callTool(name, {});
      expect(result).toEqual({ isError: true, content: [{ type: 'text', text: 'Unsupported Snipe-IT gateway tool.' }] });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await g.callTool('snipeit_check_connection', {})).isError).toBeUndefined();
    expect((await g.callTool('CHECK_CONNECTION', {})).isError).toBeUndefined();
  });
});

describe('Snipe-IT gateway policy', () => {
  it('without a host policy: reads allowed, no writes, no audit', async () => {
    const fetchImpl = snipeit();
    const g = gateway(fetchImpl);
    expect(g.tools.map(tool => tool.name)).toEqual(snipeItToolCatalog.map(tool => tool.name));
    expect((await g.callTool('list_assets', {})).isError).toBeUndefined();
    fetchImpl.mockClear();
    for (const name of WRITES) {
      const result = await g.callTool(name, MINIMAL_INPUT[name]!);
      expect(result.isError, name).toBe(true);
      expect(result.content[0]!.text).toBe('writes are disabled. The embedding host has not enabled writes for this instance.');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(existsSync(join(dir, 'audit.log'))).toBe(false);
  });

  it('leaves out and refuses the tools the host disables, and refuses an unknown tool in the policy', async () => {
    const fetchImpl = snipeit();
    const g = gateway(fetchImpl, { policy: { enableWrites: true, disabledTools: ['checkout_asset', 'snipeit_list_users'] } });
    expect(g.tools.map(tool => tool.name)).not.toContain('checkout_asset');
    expect(g.tools.map(tool => tool.name)).not.toContain('list_users');
    const result = await g.callTool('checkout_asset', MINIMAL_INPUT.checkout_asset!);
    expect(result.content[0]!.text).toBe('tool is disabled on this instance by the embedding host: snipeit_checkout_asset');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(() => gateway(fetchImpl, { policy: { disabledTools: ['list_entities'] } })).toThrow(
      'policy.disabledTools[0] is not a known gateway tool.',
    );
    expect(() => gateway(fetchImpl, { policy: { enableWrites: 'yes' as never } })).toThrow(/enableWrites/);
  });

  it('audits to the host’s sink only, with the caller as a pseudonym, and does not run a tool whose start record fails', async () => {
    const fetchImpl = snipeit();
    const { records, audit } = sink();
    await gateway(fetchImpl, { policy: { enableWrites: true, audit } }).callTool('checkin_asset', MINIMAL_INPUT.checkin_asset!, {
      caller: 'medarbejder@example.com',
      requestId: 'host-request-1',
    });
    expect(records.map(record => record.action)).toEqual(['start', 'finish']);
    expect(records[0]!.caller).toBe(callerPseudonym('medarbejder@example.com'));
    expect(JSON.stringify(records)).not.toContain('medarbejder@example.com');
    expect(JSON.stringify(records)).not.toContain('host-request-1');
    expect(records[0]).not.toHaveProperty('user');
    expect(existsSync(join(dir, 'audit.log'))).toBe(false);

    const refusing = vi.fn(async () => {
      throw new Error('sink down');
    });
    fetchImpl.mockClear();
    const result = await gateway(fetchImpl, { policy: { enableWrites: true, audit: refusing } }).callTool(
      'checkin_asset',
      MINIMAL_INPUT.checkin_asset!,
    );
    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('Snipe-IT gateway results and errors', () => {
  it('puts the summary, then the data as compact JSON, in the text block, exactly the structured content', async () => {
    const result = await gateway(snipeit({ id: 3, name: 'Office' })).callTool('get_license', { licenseId: 3 });
    expect(result.structuredContent).toEqual({ license: { id: 3, name: 'Office' } });
    expect(result.content).toEqual([{ type: 'text', text: `Snipe-IT license.\n\n${JSON.stringify(result.structuredContent)}` }]);
  });

  it('starts an error with the HTTP status in our own text and never carries the Snipe-IT body', async () => {
    for (const status of [401, 403, 404, 422, 429, 500]) {
      const fetchImpl = vi.fn<typeof fetch>(async () =>
        jsonResponse({ status: 'error', messages: 'Snipe-IT says: secret internal detail', error: 'Mette Jensen findes ikke' }, status, {
          'retry-after': '30',
        }),
      );
      const result = await gateway(fetchImpl).callTool('get_asset', { assetId: 7 });
      const text = result.content[0]!.text;
      expect(result.isError).toBe(true);
      expect(text.startsWith(`Snipe-IT API request failed with HTTP ${status}`)).toBe(true);
      expect(text).not.toMatch(/secret internal detail|Jensen|assets\.example\.com/);
      expect(text).toContain('retry-after=30s');
    }
  });

  it('turns a {"status":"error"} answer on HTTP 200 into our own text, without its messages', async () => {
    const fetchImpl = snipeit({ status: 'error', messages: { asset_tag: ['Mette Jensen took this tag'] }, payload: null });
    const result = await gateway(fetchImpl, { policy: { enableWrites: true } }).callTool('create_asset', MINIMAL_INPUT.create_asset!);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe(SNIPEIT_REFUSED);
    expect(JSON.stringify(result)).not.toContain('Jensen');
  });

  it('refuses an answer that is not JSON instead of passing it on', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('<html>login page</html>', { status: 200 }));
    const result = await gateway(fetchImpl).callTool('list_assets', {});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe('Snipe-IT answered with something that is not JSON (GET); nothing of it is passed on.');
  });

  it('redacts the key from values of a result', async () => {
    const echo = { id: 3, name: `token ${TOKEN_A} here`, notes: `Bearer ${TOKEN_A}`, license_name: TOKEN_A.slice(2, 10) };
    const result = await gateway(snipeit(echo)).callTool('get_license', { licenseId: 3 });
    const text = JSON.stringify(result);
    expect(text).not.toContain(TOKEN_A);
    expect(text).not.toContain(TOKEN_A.slice(2, 8));
  });
});

describe('Snipe-IT gateway tenants and call scopes', () => {
  it('keeps two tenants apart when they call at the same time, each with its own key, address and sink', async () => {
    const fetchA = vi.fn<typeof fetch>(async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
      return jsonResponse({ total: 1, rows: [{ id: 1, name: 'a' }] });
    });
    const fetchB = vi.fn<typeof fetch>(async () => jsonResponse({ total: 1, rows: [{ id: 2, name: 'b' }] }));
    const sinkA = sink();
    const sinkB = sink();
    const a = createSnipeItGateway({ apiToken: TOKEN_A, baseUrl: 'https://a.example.com', fetchImpl: fetchA, resolveHost, policy: { audit: sinkA.audit } });
    const b = createSnipeItGateway({
      apiToken: TOKEN_B,
      baseUrl: 'https://b.example.com',
      fetchImpl: fetchB,
      resolveHost,
      policy: { audit: sinkB.audit, disabledTools: ['list_users'] },
    });
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) => (index % 2 === 0 ? a : b).callTool('list_assets', {}, { caller: `user-${index % 2}` })),
    );
    results.forEach((result, index) =>
      expect(result.structuredContent).toEqual({ total: 1, rows: [index % 2 === 0 ? { id: 1, name: 'a' } : { id: 2, name: 'b' }] }),
    );
    for (const [url, init] of fetchA.mock.calls) {
      expect(String(url).startsWith('https://a.example.com/api/v1/')).toBe(true);
      expect(headersOf(init).Authorization).toBe(`Bearer ${TOKEN_A}`);
    }
    for (const [url, init] of fetchB.mock.calls) {
      expect(String(url).startsWith('https://b.example.com/api/v1/')).toBe(true);
      expect(headersOf(init).Authorization).toBe(`Bearer ${TOKEN_B}`);
    }
    expect(sinkA.records).toHaveLength(10);
    expect(sinkB.records).toHaveLength(10);
    expect(new Set(sinkA.records.map(record => record.caller))).toEqual(new Set([callerPseudonym('user-0')]));
    expect(new Set(sinkB.records.map(record => record.caller))).toEqual(new Set([callerPseudonym('user-1')]));
    expect((await a.callTool('list_users', {})).isError).toBeUndefined();
    expect((await b.callTool('list_users', {})).isError).toBe(true);
  });

  it('runs a call made from inside another instance’s sink under its own scope', async () => {
    const inner = gateway(snipeit());
    let innerResult: unknown;
    const outer = gateway(snipeit(), {
      policy: {
        enableWrites: true,
        audit: async record => {
          if (record.action === 'start') innerResult = await inner.callTool('checkin_asset', MINIMAL_INPUT.checkin_asset!);
        },
      },
    });
    expect((await outer.callTool('checkin_asset', MINIMAL_INPUT.checkin_asset!)).isError).toBeUndefined();
    // The inner instance has no writes: the outer policy did not leak into its call.
    expect((innerResult as { isError?: boolean }).isError).toBe(true);
  });

  it('keeps no process-wide registry: an instance’s key is not redacted outside its calls', async () => {
    gateway(snipeit());
    const { redactSecrets } = await import('../src/errors.js');
    expect(redactSecrets(`x ${TOKEN_A} y`)).toBe(`x ${TOKEN_A} y`);
  });
});
