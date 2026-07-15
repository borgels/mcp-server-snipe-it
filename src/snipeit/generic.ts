import type { SnipeItClient, QueryValue } from './client.js';
import { entityDefinition, WRITABLE_ENTITIES, type EntityName } from './entities.js';
import { assertWritesEnabled } from './policy.js';
import { MAX_LIMIT } from './assets.js';

export interface ListEntitiesInput {
  entity: EntityName;
  search?: string;
  limit?: number;
  offset?: number;
  sort?: string;
  order?: 'asc' | 'desc';
}

export async function listEntities(client: SnipeItClient, input: ListEntitiesInput): Promise<unknown> {
  const definition = entityDefinition(input.entity);
  const query: Record<string, QueryValue> = {
    search: input.search,
    limit: Math.min(input.limit ?? 50, MAX_LIMIT),
    offset: input.offset ?? 0,
    sort: input.sort,
    order: input.order,
  };
  return client.get(definition.path, query);
}

export interface GetEntityInput {
  entity: EntityName;
  id: number;
  include?: string;
}

export async function getEntity(client: SnipeItClient, input: GetEntityInput): Promise<unknown> {
  const definition = entityDefinition(input.entity);
  if (input.include) {
    if (!definition.subresources.includes(input.include)) {
      throw new Error(
        `Entity ${input.entity} has no subresource "${input.include}". Valid: ${definition.subresources.join(', ') || '(none)'}`,
      );
    }
    return client.get(`${definition.path}/${input.id}/${input.include}`);
  }
  return client.get(`${definition.path}/${input.id}`);
}

export async function createEntity(
  client: SnipeItClient,
  input: { entity: EntityName; payload: Record<string, unknown> },
): Promise<unknown> {
  assertWritesEnabled('snipeit_create_entity');
  const definition = entityDefinition(input.entity);
  if (!WRITABLE_ENTITIES.has(input.entity)) {
    throw new Error(`Entity ${input.entity} is not writable through this server.`);
  }
  return client.post(definition.path, input.payload);
}

export async function updateEntity(
  client: SnipeItClient,
  input: { entity: EntityName; id: number; patch: Record<string, unknown> },
): Promise<unknown> {
  assertWritesEnabled('snipeit_update_entity');
  const definition = entityDefinition(input.entity);
  if (!WRITABLE_ENTITIES.has(input.entity)) {
    throw new Error(`Entity ${input.entity} is not writable through this server.`);
  }
  // PATCH, never PUT: PUT is a full replace and nulls out omitted fields.
  return client.patch(`${definition.path}/${input.id}`, input.patch);
}

export interface ActivityReportInput {
  itemType?: string;
  itemId?: number;
  actionType?: string;
  targetType?: string;
  targetId?: number;
  limit?: number;
  offset?: number;
}

export async function getActivityReport(client: SnipeItClient, input: ActivityReportInput = {}): Promise<unknown> {
  return client.get('/reports/activity', {
    item_type: input.itemType,
    item_id: input.itemId,
    action_type: input.actionType,
    target_type: input.targetType,
    target_id: input.targetId,
    limit: Math.min(input.limit ?? 50, MAX_LIMIT),
    offset: input.offset ?? 0,
  });
}
