import type { SnipeItClient, QueryValue } from './client.js';
import { assertWritesEnabled } from './policy.js';

export const MAX_LIMIT = 500;

export interface ListAssetsInput {
  search?: string;
  limit?: number;
  offset?: number;
  sort?: string;
  order?: 'asc' | 'desc';
  status?: 'RTD' | 'Deployed' | 'Undeployable' | 'Deleted' | 'Archived' | 'Requestable';
  statusId?: number;
  modelId?: number;
  categoryId?: number;
  manufacturerId?: number;
  companyId?: number;
  locationId?: number;
  orderNumber?: string;
  assignedTo?: number;
  assignedType?: string;
  /** Due/overdue audit or checkin lists instead of the plain index. */
  due?: 'audits-due' | 'audits-overdue' | 'checkins-due' | 'checkins-overdue';
}

export async function listAssets(client: SnipeItClient, input: ListAssetsInput = {}): Promise<unknown> {
  const query: Record<string, QueryValue> = {
    search: input.search,
    limit: Math.min(input.limit ?? 50, MAX_LIMIT),
    offset: input.offset ?? 0,
    sort: input.sort,
    order: input.order,
    status: input.status,
    status_id: input.statusId,
    model_id: input.modelId,
    category_id: input.categoryId,
    manufacturer_id: input.manufacturerId,
    company_id: input.companyId,
    location_id: input.locationId,
    order_number: input.orderNumber,
    assigned_to: input.assignedTo,
    assigned_type: input.assignedType,
  };

  if (input.due) {
    const [kind, state] = input.due.split('-') as [string, string];
    const segment = kind === 'audits' ? 'audits' : 'checkins';
    return client.get(`/hardware/${segment}/${state}`, query);
  }

  return client.get('/hardware', query);
}

export interface GetAssetInput {
  id?: number;
  assetTag?: string;
  serial?: string;
  include?: 'licenses' | 'history' | 'assigned-assets' | 'assigned-accessories' | 'assigned-components';
}

export async function getAsset(client: SnipeItClient, input: GetAssetInput): Promise<unknown> {
  if (input.assetTag) {
    return client.get(`/hardware/bytag/${encodeURIComponent(input.assetTag)}`);
  }
  if (input.serial) {
    return client.get(`/hardware/byserial/${encodeURIComponent(input.serial)}`);
  }
  if (input.id === undefined) {
    throw new Error('Provide id, assetTag, or serial.');
  }

  if (input.include) {
    const sub = input.include.startsWith('assigned-')
      ? `assigned/${input.include.slice('assigned-'.length)}`
      : input.include;
    return client.get(`/hardware/${input.id}/${sub}`);
  }

  return client.get(`/hardware/${input.id}`);
}

export async function createAsset(client: SnipeItClient, payload: Record<string, unknown>): Promise<unknown> {
  assertWritesEnabled('snipeit_create_asset');
  return client.post('/hardware', payload);
}

export async function updateAsset(
  client: SnipeItClient,
  input: { id: number; patch: Record<string, unknown> },
): Promise<unknown> {
  assertWritesEnabled('snipeit_update_asset');
  // PATCH, never PUT: PUT is a full replace and nulls out omitted fields.
  return client.patch(`/hardware/${input.id}`, input.patch);
}

export async function auditAsset(
  client: SnipeItClient,
  input: { id: number; locationId?: number; note?: string; nextAuditDate?: string },
): Promise<unknown> {
  assertWritesEnabled('snipeit_audit_asset');
  return client.post(`/hardware/${input.id}/audit`, {
    location_id: input.locationId,
    note: input.note,
    next_audit_date: input.nextAuditDate,
  });
}
