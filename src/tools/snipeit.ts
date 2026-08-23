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
import { checkToolPolicy, perUserAuthEnabled, requireUser } from '../snipeit/policy.js';
import type { CredentialStore } from '../snipeit/store.js';
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

export interface RegisterOptions {
  /** Gateway-verified caller (X-MCP-User), when the transport forwards one. */
  onBehalfOf?: string;
  /** Per-user token store. Required in per-user mode. */
  store?: CredentialStore;
  /** Public base URL used to build the enrollment link (SNIPEIT_PUBLIC_BASE_URL). */
  publicBaseUrl?: string;
}

export function registerSnipeItTools(
  server: McpServer,
  baseClient: SnipeItClient,
  options: RegisterOptions = {},
): void {
  const perUser = perUserAuthEnabled();
  const auditUser = options.onBehalfOf;

  /**
   * Resolve the client for THIS call.
   *
   * In per-user mode the caller's own enrolled token is used, so Snipe-IT
   * applies that user's permissions and records their name in its action log.
   * Un-enrolled users get NOT_CONNECTED rather than a shared identity — there
   * is deliberately no fallback (see policy.perUserAuthEnabled).
   *
   * Resolution is lazy so that snipeit_connect stays callable before enrollment;
   * it is cheap because http.ts already builds one server per request, so the
   * store is read at most once per tool call.
   */
  const client = (): SnipeItClient => {
    if (!perUser) {
      return baseClient;
    }
    const store = options.store;
    if (!store) {
      throw new Error('Per-user auth is enabled but no credential store was provided to the server.');
    }
    const credentials = store.get(requireUser(options.onBehalfOf));
    if (!credentials) {
      throw new Error(
        'NOT_CONNECTED: your Snipe-IT account is not linked yet. Run snipeit_connect to get a one-time link, ' +
          'then paste your own Snipe-IT API token there.',
      );
    }
    return baseClient.withToken(credentials.apiToken);
  };

  const audited = <T>(tool: string, input: unknown, call: () => Promise<T>): Promise<T> =>
    runAuditedTool(tool, input, call, auditUser);

  // --- credential management (per-user mode) --------------------------------
  //
  // Registered only in per-user mode: on a shared-token instance these tools
  // would be dead weight that invites a user to enrol a token that is then
  // never used.
  if (perUser) {
    server.registerTool(
      'snipeit_connect',
      {
        title: 'Connect your Snipe-IT account',
        description:
          'Start linking YOUR Snipe-IT account. Returns a one-time link to a form where you paste your own Snipe-IT ' +
          'API token — the token is never sent through this conversation. Create one in Snipe-IT under your profile ' +
          '→ Manage API Keys. After connecting you act as yourself, with your own Snipe-IT permissions.',
        inputSchema: {},
        annotations: { ...WRITE_TOOL_ANNOTATIONS, readOnlyHint: false },
      },
      async input =>
        audited('snipeit_connect', input, async () => {
          const store = options.store;
          if (!store) {
            throw new Error('Per-user auth is enabled but no credential store was provided to the server.');
          }
          const user = requireUser(options.onBehalfOf);
          const base = (options.publicBaseUrl ?? process.env.SNIPEIT_PUBLIC_BASE_URL ?? '').replace(/\/+$/, '');
          if (!base) {
            throw new Error('SNIPEIT_PUBLIC_BASE_URL is not configured, so no enrollment link can be generated.');
          }
          const state = store.createState(user);
          return jsonToolResult({
            alreadyConnected: Boolean(store.get(user)),
            enrollmentUrl: `${base}/snipeit/enroll?state=${state}`,
            instructions:
              'Open enrollmentUrl in your browser and paste your Snipe-IT API token (Snipe-IT → your profile → ' +
              'Manage API Keys → Create New Token). The link is single-use and expires in 10 minutes.',
          });
        }),
    );

    server.registerTool(
      'snipeit_status',
      {
        title: 'Snipe-IT Connection Status',
        description: 'Whether your Snipe-IT account is linked to this connector, and which account it resolved to.',
        inputSchema: {},
        annotations: READ_TOOL_ANNOTATIONS,
      },
      async input =>
        audited('snipeit_status', input, async () => {
          const store = options.store;
          if (!store) {
            throw new Error('Per-user auth is enabled but no credential store was provided to the server.');
          }
          const credentials = store.get(requireUser(options.onBehalfOf));
          if (!credentials) {
            return jsonToolResult({ connected: false, hint: 'Run snipeit_connect to link your Snipe-IT account.' });
          }
          return jsonToolResult({
            connected: true,
            connectedAt: new Date(credentials.connectedAt).toISOString(),
            snipeUserId: credentials.snipeUserId,
            snipeUsername: credentials.snipeUsername,
          });
        }),
    );

    server.registerTool(
      'snipeit_disconnect',
      {
        title: 'Disconnect Snipe-IT',
        description:
          'Remove your stored Snipe-IT API token from this server. This does NOT revoke the token in Snipe-IT — ' +
          'do that under your profile → Manage API Keys.',
        inputSchema: {},
        annotations: { ...WRITE_TOOL_ANNOTATIONS, readOnlyHint: false },
      },
      async input =>
        audited('snipeit_disconnect', input, async () => {
          const store = options.store;
          if (!store) {
            throw new Error('Per-user auth is enabled but no credential store was provided to the server.');
          }
          return jsonToolResult({ disconnected: store.delete(requireUser(options.onBehalfOf)) });
        }),
    );
  }

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
      audited('snipeit_search_capabilities', input, async () =>
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
      audited('snipeit_list_assets', input, async () => jsonToolResult(await listAssets(client(), input))),
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
      audited('snipeit_get_asset', input, async () => jsonToolResult(await getAsset(client(), input))),
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
      audited('snipeit_list_entities', input, async () => jsonToolResult(await listEntities(client(), input))),
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
      audited('snipeit_get_entity', input, async () => jsonToolResult(await getEntity(client(), input))),
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
      audited('snipeit_get_activity_report', input, async () =>
        jsonToolResult(await getActivityReport(client(), input)),
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
      audited('snipeit_create_asset', input, async () =>
        jsonToolResult(await createAsset(client(), input.payload)),
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
      audited('snipeit_update_asset', input, async () => jsonToolResult(await updateAsset(client(), input))),
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
      audited('snipeit_create_entity', input, async () => jsonToolResult(await createEntity(client(), input))),
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
      audited('snipeit_update_entity', input, async () => jsonToolResult(await updateEntity(client(), input))),
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
      audited('snipeit_checkout', input, async () => jsonToolResult(await checkout(client(), input))),
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
      audited('snipeit_checkin', input, async () => jsonToolResult(await checkin(client(), input))),
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
      audited('snipeit_audit_asset', input, async () => jsonToolResult(await auditAsset(client(), input))),
  );
}

async function runAuditedTool<T>(
  tool: string,
  input: unknown,
  call: () => Promise<T>,
  user?: string,
): Promise<T> {
  const policy = checkToolPolicy(tool);
  const target = auditTarget(input);

  if (!policy.allowed) {
    await writeAuditEvent({ tool, action: 'policy_denied', target, reason: policy.reason, user });
    throw new Error(policy.reason);
  }

  await writeAuditEvent({ tool, action: 'start', target, reason: policy.reason, user });

  try {
    const result = await call();
    await writeAuditEvent({ tool, action: 'finish', target, status: 'ok', user });
    return result;
  } catch (error) {
    await writeAuditEvent({
      tool,
      action: 'error',
      target,
      status: 'error',
      error: formatUnknownError(error),
      user,
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
