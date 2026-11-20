import type { QueryValue, SnipeItClient } from './client.js';
import { safePathSegment } from './path.js';

/**
 * The narrow operations of the embedded gateway (src/tools/gateway-tools.ts).
 *
 * Every answer is projected onto an allowlist of fields before it leaves: a
 * field that is not named here is never passed on. So a license's product
 * key (`product_key`, the `serial` of a license) is never returned, nor are
 * custom fields of assets (they can hold encrypted values such as recovery
 * keys), phone numbers, addresses or employee numbers of users, IP addresses
 * and user agents of the activity log, or anything Snipe-IT adds later.
 */

type Json = Record<string, unknown>;

/** Largest page a gateway list asks for. */
export const GATEWAY_MAX_LIMIT = 100;

function asObject(value: unknown): Json | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : undefined;
}

/**
 * A plain value: a string, number or boolean as it is, or an object of only
 * such values (Snipe-IT's `{date, formatted}` dates and `{amount, ...}`
 * values); anything else is dropped.
 */
function plain(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  const object = asObject(value);
  if (object && Object.values(object).every(entry => entry === null || ['string', 'number', 'boolean'].includes(typeof entry))) {
    return { ...object };
  }
  return undefined;
}

/** A related record as `{id, name}` (and `type` where Snipe-IT gives one), or null. */
function ref(value: unknown): unknown {
  const object = asObject(value);
  if (!object) return value === null ? null : undefined;
  return pick(object, { id: plain, name: plain, type: plain });
}

/** Who something is assigned to: id, name and type, and for a person the user name and mail. */
function assignee(value: unknown): unknown {
  const object = asObject(value);
  if (!object) return value === null ? null : undefined;
  return pick(object, { id: plain, name: plain, type: plain, username: plain, email: plain });
}

type Projection = Record<string, (value: unknown) => unknown>;

/** Only the named fields of `source`, each through its projection; fields that come out undefined are left out. */
function pick(source: Json, projection: Projection): Json {
  const out: Json = {};
  for (const [field, project] of Object.entries(projection)) {
    if (!Object.hasOwn(source, field)) continue;
    const value = project(source[field]);
    if (value !== undefined) out[field] = value;
  }
  return out;
}

function projector(projection: Projection): (value: unknown) => Json {
  return value => pick(asObject(value) ?? {}, projection);
}

const ASSET = projector({
  id: plain,
  name: plain,
  asset_tag: plain,
  serial: plain,
  model: ref,
  model_number: plain,
  category: ref,
  manufacturer: ref,
  status_label: value => {
    const object = asObject(value);
    return object ? pick(object, { id: plain, name: plain, status_type: plain, status_meta: plain }) : undefined;
  },
  company: ref,
  location: ref,
  rtd_location: ref,
  assigned_to: assignee,
  supplier: ref,
  order_number: plain,
  purchase_date: plain,
  purchase_cost: plain,
  warranty_months: plain,
  warranty_expires: plain,
  notes: plain,
  requestable: plain,
  expected_checkin: plain,
  last_checkout: plain,
  last_audit_date: plain,
  next_audit_date: plain,
  created_at: plain,
  updated_at: plain,
});

/** A license without its product key: `product_key` and `serial` are not in the allowlist. */
const LICENSE = projector({
  id: plain,
  name: plain,
  company: ref,
  manufacturer: ref,
  category: ref,
  supplier: ref,
  license_name: plain,
  license_email: plain,
  order_number: plain,
  purchase_order: plain,
  purchase_date: plain,
  purchase_cost: plain,
  expiration_date: plain,
  termination_date: plain,
  seats: plain,
  free_seats_count: plain,
  reassignable: plain,
  maintained: plain,
  notes: plain,
  created_at: plain,
  updated_at: plain,
});

const SEAT = projector({
  id: plain,
  license_id: plain,
  name: plain,
  assigned_user: assignee,
  assigned_asset: ref,
  location: ref,
  reassignable: plain,
  notes: plain,
});

const STOCK_ITEM: Projection = {
  id: plain,
  name: plain,
  category: ref,
  manufacturer: ref,
  company: ref,
  location: ref,
  supplier: ref,
  model_number: plain,
  order_number: plain,
  purchase_date: plain,
  purchase_cost: plain,
  qty: plain,
  remaining: plain,
  notes: plain,
  created_at: plain,
  updated_at: plain,
};

const ACCESSORY = projector({ ...STOCK_ITEM, remaining_qty: plain, min_qty: plain, checkouts_count: plain });
const CONSUMABLE = projector({ ...STOCK_ITEM, item_no: plain, min_amt: plain });
const COMPONENT = projector({ ...STOCK_ITEM, serial: plain, min_amt: plain });

/** A user: name, user name, mail, department, location and the counts of what is assigned. Nothing else. */
const USER = projector({
  id: plain,
  name: plain,
  username: plain,
  email: plain,
  department: ref,
  location: ref,
  assets_count: plain,
  licenses_count: plain,
  accessories_count: plain,
  consumables_count: plain,
});

const LOCATION = projector({
  id: plain,
  name: plain,
  parent: ref,
  company: ref,
  city: plain,
  country: plain,
  assets_count: plain,
  assigned_assets_count: plain,
  users_count: plain,
});

const ACTIVITY = projector({
  id: plain,
  created_at: plain,
  action_date: plain,
  action_type: plain,
  item: ref,
  target: ref,
  admin: ref,
  created_by: ref,
  location: ref,
  note: plain,
});

export const REFERENCE_KINDS = ['models', 'categories', 'manufacturers', 'statuslabels', 'suppliers', 'departments'] as const;
export type ReferenceKind = (typeof REFERENCE_KINDS)[number];

const REFERENCE: Record<ReferenceKind, (value: unknown) => Json> = {
  models: projector({ id: plain, name: plain, model_number: plain, manufacturer: ref, category: ref, assets_count: plain }),
  categories: projector({ id: plain, name: plain, category_type: plain, item_count: plain }),
  manufacturers: projector({ id: plain, name: plain }),
  statuslabels: projector({ id: plain, name: plain, type: plain }),
  suppliers: projector({ id: plain, name: plain }),
  departments: projector({ id: plain, name: plain, company: ref, location: ref, users_count: plain }),
};

/** A list answer (`{total, rows}`) with every row projected. */
function list(response: unknown, project: (value: unknown) => Json): { total: number; rows: Json[] } {
  const object = asObject(response);
  const rows = Array.isArray(object?.rows) ? object.rows : [];
  const total = typeof object?.total === 'number' ? object.total : rows.length;
  return { total, rows: rows.map(project) };
}

/** A projection of plain (string, number, boolean or null) values only, for the raw records of a write answer. */
function scalars(fields: readonly string[]): (value: unknown) => Json {
  const scalar = (value: unknown) => (asObject(value) || Array.isArray(value) ? undefined : plain(value));
  return projector(Object.fromEntries(fields.map(field => [field, scalar])));
}

/** The fields of an asset write answer's payload that are passed on. Custom field columns are not among them. */
const ASSET_WRITE = scalars([
  'id',
  'name',
  'asset_tag',
  'serial',
  'model_id',
  'status_id',
  'company_id',
  'location_id',
  'rtd_location_id',
  'supplier_id',
  'assigned_to',
  'assigned_type',
  'order_number',
  'purchase_date',
  'purchase_cost',
  'warranty_months',
  'requestable',
  'notes',
  'note',
  'expected_checkin',
  'last_checkout',
  'last_audit_date',
  'next_audit_date',
  'created_at',
  'updated_at',
]);

/** The fields of a license seat write answer's payload that are passed on: never a serial or key of the license. */
const SEAT_WRITE = scalars(['id', 'license_id', 'assigned_to', 'asset_id', 'notes', 'updated_at']);

/** A write answer (`{status, messages, payload}`): the status, a message text and the allowlisted payload fields. */
function written(response: unknown, project: (value: unknown) => Json): Json {
  const object = asObject(response) ?? {};
  const messages = typeof object.messages === 'string' ? object.messages.slice(0, 500) : undefined;
  return {
    status: typeof object.status === 'string' ? object.status : 'success',
    ...(messages ? { messages } : {}),
    item: project(object.payload),
  };
}

function page(input: { limit?: number; offset?: number }): Record<string, QueryValue> {
  return { limit: Math.min(input.limit ?? 50, GATEWAY_MAX_LIMIT), offset: input.offset ?? 0 };
}

/** Snipe-IT stores the assignee type as its model class. */
const ASSIGNED_TYPES = { user: 'App\\Models\\User', asset: 'App\\Models\\Asset', location: 'App\\Models\\Location' } as const;
export type TargetType = keyof typeof ASSIGNED_TYPES;

// --- reads --------------------------------------------------------------------------------------------------------

/** The token's own user: who every call of an embedded gateway runs as. */
export async function checkConnection(client: SnipeItClient): Promise<unknown> {
  const me = asObject(await client.get('/users/me')) ?? {};
  return { connected: true, user: pick(me, { id: plain, name: plain, username: plain, email: plain }) };
}

export interface GatewayListAssetsInput {
  search?: string;
  status?: 'RTD' | 'Deployed' | 'Undeployable' | 'Archived' | 'Requestable';
  statusId?: number;
  modelId?: number;
  categoryId?: number;
  manufacturerId?: number;
  companyId?: number;
  locationId?: number;
  assignedTo?: number;
  assignedType?: TargetType;
  due?: 'audits-due' | 'audits-overdue' | 'checkins-due' | 'checkins-overdue';
  limit?: number;
  offset?: number;
}

export async function listAssets(client: SnipeItClient, input: GatewayListAssetsInput): Promise<unknown> {
  const query: Record<string, QueryValue> = {
    search: input.search,
    status: input.status,
    status_id: input.statusId,
    model_id: input.modelId,
    category_id: input.categoryId,
    manufacturer_id: input.manufacturerId,
    company_id: input.companyId,
    location_id: input.locationId,
    assigned_to: input.assignedTo,
    assigned_type: input.assignedTo === undefined ? undefined : ASSIGNED_TYPES[input.assignedType ?? 'user'],
    ...page(input),
  };
  if (input.due) {
    const [kind, state] = input.due.split('-') as ['audits' | 'checkins', 'due' | 'overdue'];
    return list(await client.get(`/hardware/${kind}/${state}`, query), ASSET);
  }
  return list(await client.get('/hardware', query), ASSET);
}

export async function getAsset(
  client: SnipeItClient,
  input: { assetId?: number; assetTag?: string; serial?: string },
): Promise<unknown> {
  const given = [input.assetId !== undefined, input.assetTag !== undefined, input.serial !== undefined].filter(Boolean);
  if (given.length !== 1) {
    throw new Error('Give exactly one of assetId, assetTag or serial.');
  }
  if (input.assetTag !== undefined) {
    return { asset: ASSET(await client.get(`/hardware/bytag/${safePathSegment(input.assetTag, 'assetTag')}`)) };
  }
  if (input.serial !== undefined) {
    // Several assets can share a serial number: Snipe-IT answers with a list.
    return list(await client.get(`/hardware/byserial/${safePathSegment(input.serial, 'serial')}`), ASSET);
  }
  return { asset: ASSET(await client.get(`/hardware/${input.assetId}`)) };
}

export async function listLicenses(
  client: SnipeItClient,
  input: { search?: string; categoryId?: number; manufacturerId?: number; companyId?: number; expired?: boolean; limit?: number; offset?: number },
): Promise<unknown> {
  return list(
    await client.get('/licenses', {
      search: input.search,
      category_id: input.categoryId,
      manufacturer_id: input.manufacturerId,
      company_id: input.companyId,
      // Snipe-IT reads any filled value as "on": only sent when asked for.
      expires: input.expired === true ? 'true' : undefined,
      ...page(input),
    }),
    LICENSE,
  );
}

export async function getLicense(
  client: SnipeItClient,
  input: { licenseId: number; includeSeats?: boolean; seatsOffset?: number },
): Promise<unknown> {
  const license = LICENSE(await client.get(`/licenses/${input.licenseId}`));
  if (!input.includeSeats) {
    return { license };
  }
  const seats = list(
    await client.get(`/licenses/${input.licenseId}/seats`, { limit: GATEWAY_MAX_LIMIT, offset: input.seatsOffset ?? 0 }),
    SEAT,
  );
  return { license, seats };
}

interface StockListInput {
  search?: string;
  categoryId?: number;
  manufacturerId?: number;
  companyId?: number;
  locationId?: number;
  limit?: number;
  offset?: number;
}

function stockQuery(input: StockListInput): Record<string, QueryValue> {
  return {
    search: input.search,
    category_id: input.categoryId,
    manufacturer_id: input.manufacturerId,
    company_id: input.companyId,
    location_id: input.locationId,
    ...page(input),
  };
}

export async function listAccessories(client: SnipeItClient, input: StockListInput): Promise<unknown> {
  return list(await client.get('/accessories', stockQuery(input)), ACCESSORY);
}

export async function listConsumables(client: SnipeItClient, input: StockListInput): Promise<unknown> {
  return list(await client.get('/consumables', stockQuery(input)), CONSUMABLE);
}

export async function listComponents(client: SnipeItClient, input: StockListInput): Promise<unknown> {
  return list(await client.get('/components', stockQuery(input)), COMPONENT);
}

export async function listUsers(
  client: SnipeItClient,
  input: { search?: string; userId?: number; departmentId?: number; locationId?: number; companyId?: number; limit?: number; offset?: number },
): Promise<unknown> {
  if (input.userId !== undefined) {
    return { user: USER(await client.get(`/users/${input.userId}`)) };
  }
  return list(
    await client.get('/users', {
      search: input.search,
      department_id: input.departmentId,
      location_id: input.locationId,
      company_id: input.companyId,
      ...page(input),
    }),
    USER,
  );
}

export async function listLocations(
  client: SnipeItClient,
  input: { search?: string; parentId?: number; limit?: number; offset?: number },
): Promise<unknown> {
  return list(await client.get('/locations', { search: input.search, parent_id: input.parentId, ...page(input) }), LOCATION);
}

export async function listReferenceData(
  client: SnipeItClient,
  input: { kind: ReferenceKind; search?: string; limit?: number; offset?: number },
): Promise<unknown> {
  return { kind: input.kind, ...list(await client.get(`/${input.kind}`, { search: input.search, ...page(input) }), REFERENCE[input.kind]) };
}

export async function getActivityReport(
  client: SnipeItClient,
  input: {
    itemType?: string;
    itemId?: number;
    actionType?: string;
    targetType?: TargetType;
    targetId?: number;
    limit?: number;
    offset?: number;
  },
): Promise<unknown> {
  // Snipe-IT applies an item or target filter only when both its type and its id are given; one alone would be
  // ignored silently and the answer would look filtered.
  if ((input.itemType === undefined) !== (input.itemId === undefined)) {
    throw new Error('Give itemType and itemId together, or neither.');
  }
  if ((input.targetType === undefined) !== (input.targetId === undefined)) {
    throw new Error('Give targetType and targetId together, or neither.');
  }
  return list(
    await client.get('/reports/activity', {
      item_type: input.itemType,
      item_id: input.itemId,
      action_type: input.actionType,
      target_type: input.targetType,
      target_id: input.targetId,
      limit: Math.min(input.limit ?? 25, GATEWAY_MAX_LIMIT),
      offset: input.offset ?? 0,
    }),
    ACTIVITY,
  );
}

// --- writes -------------------------------------------------------------------------------------------------------

export interface AssetFieldsInput {
  name?: string;
  statusId?: number;
  locationId?: number;
  defaultLocationId?: number;
  notes?: string;
  orderNumber?: string;
  purchaseDate?: string;
  warrantyMonths?: number;
}

function assetFields(input: AssetFieldsInput): Json {
  const body: Json = {
    name: input.name,
    status_id: input.statusId,
    location_id: input.locationId,
    rtd_location_id: input.defaultLocationId,
    notes: input.notes,
    order_number: input.orderNumber,
    purchase_date: input.purchaseDate,
    warranty_months: input.warrantyMonths,
  };
  return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));
}

export async function createAsset(
  client: SnipeItClient,
  input: AssetFieldsInput & {
    modelId: number;
    statusId: number;
    assetTag?: string;
    serial?: string;
    companyId?: number;
    supplierId?: number;
    purchaseCost?: number;
    requestable?: boolean;
  },
): Promise<unknown> {
  const body: Json = {
    ...assetFields(input),
    model_id: input.modelId,
    status_id: input.statusId,
    ...(input.assetTag !== undefined ? { asset_tag: input.assetTag } : {}),
    ...(input.serial !== undefined ? { serial: input.serial } : {}),
    ...(input.companyId !== undefined ? { company_id: input.companyId } : {}),
    ...(input.supplierId !== undefined ? { supplier_id: input.supplierId } : {}),
    ...(input.purchaseCost !== undefined ? { purchase_cost: input.purchaseCost } : {}),
    ...(input.requestable !== undefined ? { requestable: input.requestable } : {}),
  };
  return written(await client.post('/hardware', body), ASSET_WRITE);
}

export async function updateAsset(client: SnipeItClient, input: AssetFieldsInput & { assetId: number }): Promise<unknown> {
  const body = assetFields(input);
  if (Object.keys(body).length === 0) {
    throw new Error('Give at least one field to change.');
  }
  // PATCH, never PUT: PUT is a full replace and nulls out omitted fields.
  return written(await client.patch(`/hardware/${input.assetId}`, body), ASSET_WRITE);
}

export async function checkoutAsset(
  client: SnipeItClient,
  input: { assetId: number; targetType?: TargetType; targetId: number; expectedCheckin?: string; statusId?: number; note?: string },
): Promise<unknown> {
  const targetType = input.targetType ?? 'user';
  const field = targetType === 'user' ? 'assigned_user' : targetType === 'asset' ? 'assigned_asset' : 'assigned_location';
  return written(
    await client.post(`/hardware/${input.assetId}/checkout`, {
      checkout_to_type: targetType,
      [field]: input.targetId,
      expected_checkin: input.expectedCheckin,
      status_id: input.statusId,
      note: input.note,
    }),
    ASSET_WRITE,
  );
}

export async function checkinAsset(
  client: SnipeItClient,
  input: { assetId: number; locationId?: number; statusId?: number; note?: string },
): Promise<unknown> {
  return written(
    await client.post(`/hardware/${input.assetId}/checkin`, {
      location_id: input.locationId,
      status_id: input.statusId,
      note: input.note,
    }),
    ASSET_WRITE,
  );
}

export async function auditAsset(
  client: SnipeItClient,
  input: { assetId: number; locationId?: number; nextAuditDate?: string; note?: string },
): Promise<unknown> {
  return written(
    await client.post(`/hardware/${input.assetId}/audit`, {
      location_id: input.locationId,
      next_audit_date: input.nextAuditDate,
      note: input.note,
    }),
    ASSET_WRITE,
  );
}

export async function checkoutLicenseSeat(
  client: SnipeItClient,
  input: { licenseId: number; seatId: number; targetType?: 'user' | 'asset'; targetId: number; note?: string },
): Promise<unknown> {
  // Only a free seat is assigned: Snipe-IT keeps an existing assignment of the other kind, so a taken seat is refused.
  const seat = asObject(await client.get(`/licenses/${input.licenseId}/seats/${input.seatId}`)) ?? {};
  if (asObject(seat.assigned_user) || asObject(seat.assigned_asset)) {
    throw new Error('The seat is taken. Free it first with checkin_license_seat, or pick a free seat (get_license with includeSeats).');
  }
  const target = (input.targetType ?? 'user') === 'user' ? { assigned_to: input.targetId } : { asset_id: input.targetId };
  return written(
    await client.patch(`/licenses/${input.licenseId}/seats/${input.seatId}`, { ...target, notes: input.note }),
    SEAT_WRITE,
  );
}

export async function checkinLicenseSeat(
  client: SnipeItClient,
  input: { licenseId: number; seatId: number; note?: string },
): Promise<unknown> {
  return written(
    await client.patch(`/licenses/${input.licenseId}/seats/${input.seatId}`, { assigned_to: null, asset_id: null, notes: input.note }),
    SEAT_WRITE,
  );
}
