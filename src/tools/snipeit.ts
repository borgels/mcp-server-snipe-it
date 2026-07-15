import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { formatUnknownError } from '../errors.js';
import { writeAuditEvent } from '../snipeit/audit.js';
import {
  READ_TOOL_ANNOTATIONS,
  WRITE_TOOL_ANNOTATIONS,
  searchCapabilities,
} from '../snipeit/capabilities.js';
import type { SnipeItClient } from '../snipeit/client.js';
import { checkToolPolicy } from '../snipeit/policy.js';
import { ENTITY_NAMES } from '../snipeit/entities.js';
import {
  auditAsset,
  createAsset,
  getAsset,
  listAssets,
  MAX_LIMIT,
  updateAsset,
} from '../snipeit/assets.js';
import { checkin, checkout } from '../snipeit/checkouts.js';
import {
  createEntity,
  getActivityReport,
  getEntity,
  listEntities,
  updateEntity,
} from '../snipeit/generic.js';

const limitSchema = z.number().int().min(1).max(MAX_LIMIT).optional().describe('Rows per page (default 50, max 500).');
const offsetSchema = z.number().int().min(0).optional();
const orderSchema = z.enum(['asc', 'desc']).optional();
const entitySchema = z.enum(ENTITY_NAMES).describe('Entity type (assets/hardware have their own tools).');
const payloadSchema = z.record(z.string(), z.unknown()).describe('Snipe-IT API fields (snake_case).');

export function registerSnipeItTools(server: McpServer, client: SnipeItClient): void {
  server.registerTool(
    'snipeit_search_capabilities',
    {
      title: 'Search Snipe-IT Capabilities',
      description: 'Search the Snipe-IT MCP server capabilities and examples. Use this first when deciding which tool to call.',
      inputSchema: {
        query: z.string().trim().default(''),
        limit: z.number().int().min(1).max(50).default(20),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('snipeit_search_capabilities', input, async () =>
        jsonToolResult(searchCapabilities(input.query, input.limit)),
      ),
  );

  server.registerTool(
    'snipeit_list_assets',
    {
      title: 'List Assets (Snipe-IT)',
      description:
        'Search/list hardware assets. Filters: free-text search, meta-status (RTD=ready to deploy, Deployed, Undeployable, Deleted, Archived, Requestable), status label id, model/category/manufacturer/company/location ids, assignee. `due` lists assets due/overdue for audit or check-in instead. Response: {total, rows} — page with limit/offset.',
      inputSchema: {
        search: z.string().trim().min(1).optional(),
        status: z.enum(['RTD', 'Deployed', 'Undeployable', 'Deleted', 'Archived', 'Requestable']).optional(),
        statusId: z.number().int().optional(),
        modelId: z.number().int().optional(),
        categoryId: z.number().int().optional(),
        manufacturerId: z.number().int().optional(),
        companyId: z.number().int().optional(),
        locationId: z.number().int().optional(),
        orderNumber: z.string().trim().optional(),
        assignedTo: z.number().int().optional(),
        assignedType: z.string().trim().optional(),
        due: z.enum(['audits-due', 'audits-overdue', 'checkins-due', 'checkins-overdue']).optional(),
        sort: z.string().trim().optional(),
        order: orderSchema,
        limit: limitSchema,
        offset: offsetSchema,
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('snipeit_list_assets', input, async () => jsonToolResult(await listAssets(client, input))),
  );

  server.registerTool(
    'snipeit_get_asset',
    {
      title: 'Get Asset (Snipe-IT)',
      description:
        'Fetch one asset by id, assetTag, or serial. With id, include can fetch: licenses, history, assigned-assets, assigned-accessories, assigned-components.',
      inputSchema: {
        id: z.number().int().optional(),
        assetTag: z.string().trim().min(1).optional(),
        serial: z.string().trim().min(1).optional(),
        include: z.enum(['licenses', 'history', 'assigned-assets', 'assigned-accessories', 'assigned-components']).optional(),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('snipeit_get_asset', input, async () => jsonToolResult(await getAsset(client, input))),
  );

  server.registerTool(
    'snipeit_list_entities',
    {
      title: 'List Entities (Snipe-IT)',
      description:
        'List licenses, accessories, consumables, components, users, locations, statuslabels, categories, manufacturers, models, companies, departments, suppliers, fields, fieldsets, kits, maintenances, depreciations, or groups. Response: {total, rows}.',
      inputSchema: {
        entity: entitySchema,
        search: z.string().trim().min(1).optional(),
        sort: z.string().trim().optional(),
        order: orderSchema,
        limit: limitSchema,
        offset: offsetSchema,
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('snipeit_list_entities', input, async () => jsonToolResult(await listEntities(client, input))),
  );

  server.registerTool(
    'snipeit_get_entity',
    {
      title: 'Get Entity (Snipe-IT)',
      description:
        'Fetch one entity by id, or a subresource via include — e.g. licenses include=seats (seat ids for checkin), accessories include=checkedout (pivot-row ids for checkin), components include=assets, users include=assets|accessories|licenses|history.',
      inputSchema: {
        entity: entitySchema,
        id: z.number().int(),
        include: z.string().trim().min(1).optional(),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('snipeit_get_entity', input, async () => jsonToolResult(await getEntity(client, input))),
  );

  server.registerTool(
    'snipeit_get_activity_report',
    {
      title: 'Get Activity Report (Snipe-IT)',
      description:
        'The Snipe-IT audit trail: checkouts, checkins, creates, updates, audits — who did what, when, to which item. Filterable by item, action type, and target.',
      inputSchema: {
        itemType: z.string().trim().optional().describe('e.g. asset, license, accessory, user'),
        itemId: z.number().int().optional(),
        actionType: z.string().trim().optional().describe('e.g. checkout, "checkin from", update, "create new", audit'),
        targetType: z.string().trim().optional(),
        targetId: z.number().int().optional(),
        limit: limitSchema,
        offset: offsetSchema,
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('snipeit_get_activity_report', input, async () =>
        jsonToolResult(await getActivityReport(client, input)),
      ),
  );

  server.registerTool(
    'snipeit_create_asset',
    {
      title: 'Create Asset (Snipe-IT)',
      description:
        'Create a hardware asset. Minimum: model_id and status_id (asset_tag too unless auto-increment is enabled). Requires write access on this instance.',
      inputSchema: { payload: payloadSchema },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('snipeit_create_asset', input, async () =>
        jsonToolResult(await createAsset(client, input.payload)),
      ),
  );

  server.registerTool(
    'snipeit_update_asset',
    {
      title: 'Update Asset (Snipe-IT)',
      description: 'Partially update an asset — only the fields in patch change (PATCH semantics). Requires write access.',
      inputSchema: {
        id: z.number().int(),
        patch: payloadSchema,
      },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('snipeit_update_asset', input, async () => jsonToolResult(await updateAsset(client, input))),
  );

  server.registerTool(
    'snipeit_create_entity',
    {
      title: 'Create Entity (Snipe-IT)',
      description: 'Create a non-asset entity (user, license, accessory, consumable, component, location, category, model, supplier, maintenance, …). Requires write access.',
      inputSchema: {
        entity: entitySchema,
        payload: payloadSchema,
      },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('snipeit_create_entity', input, async () => jsonToolResult(await createEntity(client, input))),
  );

  server.registerTool(
    'snipeit_update_entity',
    {
      title: 'Update Entity (Snipe-IT)',
      description: 'Partially update a non-asset entity (PATCH semantics). Requires write access.',
      inputSchema: {
        entity: entitySchema,
        id: z.number().int(),
        patch: payloadSchema,
      },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('snipeit_update_entity', input, async () => jsonToolResult(await updateEntity(client, input))),
  );

  server.registerTool(
    'snipeit_checkout',
    {
      title: 'Check Out (Snipe-IT)',
      description:
        'Check out to someone/something: asset → user/asset/location; accessory → user (or asset/location); consumable → user (IRREVERSIBLE — confirm with the user first); component → asset; license → user/asset (optionally a specific seatId). Requires write access.',
      inputSchema: {
        type: z.enum(['asset', 'accessory', 'consumable', 'component', 'license']),
        id: z.number().int().describe('The entity id to check out.'),
        targetType: z.enum(['user', 'asset', 'location']).optional().describe('Default: user (component: asset).'),
        targetId: z.number().int(),
        quantity: z.number().int().min(1).optional().describe('accessory/consumable/component quantity (default 1).'),
        statusId: z.number().int().optional().describe('Asset checkout: status label to set.'),
        seatId: z.number().int().optional().describe('License checkout: specific seat (default: first free).'),
        expectedCheckin: z.string().trim().optional().describe('Asset checkout: expected return date (YYYY-MM-DD).'),
        note: z.string().trim().optional(),
      },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('snipeit_checkout', input, async () => jsonToolResult(await checkout(client, input))),
  );

  server.registerTool(
    'snipeit_checkin',
    {
      title: 'Check In (Snipe-IT)',
      description:
        'Check in an asset, accessory, component, or license seat (consumables cannot be checked in). GOTCHA: for accessory/component the id is the PIVOT-ROW id from snipeit_get_entity include=checkedout / include=assets — not the entity id. License checkin needs seatId; on a non-reassignable license this permanently burns the seat. Requires write access.',
      inputSchema: {
        type: z.enum(['asset', 'accessory', 'component', 'license']),
        id: z.number().int(),
        quantity: z.number().int().min(1).optional().describe('Component checkin quantity (default 1).'),
        seatId: z.number().int().optional().describe('Required for license checkin.'),
        locationId: z.number().int().optional().describe('Asset checkin: new location.'),
        statusId: z.number().int().optional().describe('Asset checkin: status label to set.'),
        note: z.string().trim().optional(),
      },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('snipeit_checkin', input, async () => jsonToolResult(await checkin(client, input))),
  );

  server.registerTool(
    'snipeit_audit_asset',
    {
      title: 'Audit Asset (Snipe-IT)',
      description: 'Record a physical audit of an asset — append-only log entry; optionally set location and next audit date. Requires write access.',
      inputSchema: {
        id: z.number().int(),
        locationId: z.number().int().optional(),
        note: z.string().trim().optional(),
        nextAuditDate: z.string().trim().optional().describe('YYYY-MM-DD'),
      },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('snipeit_audit_asset', input, async () => jsonToolResult(await auditAsset(client, input))),
  );
}

async function runAuditedTool<T>(tool: string, input: unknown, call: () => Promise<T>): Promise<T> {
  const policy = checkToolPolicy(tool);
  const target = auditTarget(input);

  if (!policy.allowed) {
    await writeAuditEvent({ tool, action: 'policy_denied', target, reason: policy.reason });
    throw new Error(policy.reason);
  }

  await writeAuditEvent({ tool, action: 'start', target, reason: policy.reason });

  try {
    const result = await call();
    await writeAuditEvent({ tool, action: 'finish', target, status: 'ok' });
    return result;
  } catch (error) {
    await writeAuditEvent({
      tool,
      action: 'error',
      target,
      status: 'error',
      error: formatUnknownError(error),
    });
    throw error;
  }
}

function auditTarget(input: unknown): unknown {
  if (!input || typeof input !== 'object') {
    return input;
  }
  const value = input as Record<string, unknown>;
  return {
    entity: value.entity,
    id: value.id,
    assetTag: value.assetTag,
    serial: value.serial,
    include: value.include,
    type: value.type,
    targetType: value.targetType,
    targetId: value.targetId,
    quantity: value.quantity,
    seatId: value.seatId,
    itemType: value.itemType,
    itemId: value.itemId,
    actionType: value.actionType,
    query: value.query,
    search: value.search,
    due: value.due,
  };
}

function jsonToolResult(data: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}
