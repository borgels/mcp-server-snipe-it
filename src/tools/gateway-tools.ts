import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { writeAuditEvent } from '../snipeit/audit.js';
import { READ_TOOL_ANNOTATIONS, WRITE_TOOL_ANNOTATIONS } from '../snipeit/capabilities.js';
import type { SnipeItClient } from '../snipeit/client.js';
import { searchGatewayCapabilities } from '../snipeit/gateway-capabilities.js';
import {
  auditAsset,
  checkConnection,
  checkinAsset,
  checkinLicenseSeat,
  checkoutAsset,
  checkoutLicenseSeat,
  createAsset,
  GATEWAY_MAX_LIMIT,
  getActivityReport,
  getAsset,
  getLicense,
  listAccessories,
  listAssets,
  listComponents,
  listConsumables,
  listLicenses,
  listLocations,
  listReferenceData,
  listUsers,
  REFERENCE_KINDS,
  updateAsset,
} from '../snipeit/gateway-ops.js';
import { checkToolPolicy } from '../snipeit/policy.js';
import { currentOfferedTools } from '../snipeit/scope.js';

/**
 * The tools of the embedded gateway (src/gateway.ts). They run as the API
 * key's own user under the host's policy, with narrow inputs: no generic
 * entity access, no raw paths, nothing that deletes. The MCP server's own
 * tools (src/tools/snipeit.ts) are unchanged.
 *
 * Read tools get a view of the client that can only GET.
 */
function readOnly(client: SnipeItClient, tool: string): SnipeItClient {
  const refuse = async () => {
    throw new Error(`Read tool ${tool} attempted a change in Snipe-IT; refused.`);
  };
  return Object.assign(Object.create(client) as SnipeItClient, { post: refuse, patch: refuse });
}

const id = z.number().int().positive();
const text = (max: number) => z.string().trim().min(1).max(max);
const date = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'a date as YYYY-MM-DD');
const pageShape = {
  limit: z.number().int().min(1).max(GATEWAY_MAX_LIMIT).optional().describe('Rows per page (default 50, at most 100).'),
  offset: z.number().int().min(0).optional(),
};
const stockShape = {
  search: text(200).optional(),
  categoryId: id.optional(),
  manufacturerId: id.optional(),
  companyId: id.optional(),
  locationId: id.optional(),
  ...pageShape,
};
const assetFieldsShape = {
  name: text(255).optional(),
  statusId: id.optional().describe('Status label id (list_reference_data kind=statuslabels).'),
  locationId: id.optional().describe('Current location id.'),
  defaultLocationId: id.optional().describe('Default location id (where the asset returns to).'),
  notes: z.string().trim().max(10_000).optional(),
  orderNumber: text(100).optional(),
  purchaseDate: date.optional(),
  warrantyMonths: z.number().int().min(0).max(1200).optional(),
};

/** Runs a gateway tool: the host's policy first, then the audit's start record, the call, and its finish or error. */
async function runGatewayTool(tool: string, input: unknown, call: () => Promise<unknown>) {
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
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  } catch (error) {
    // The error object itself: the audit classifies it into a fixed code (http_<status>, timeout or error).
    await writeAuditEvent({ tool, action: 'error', target, status: 'error', error });
    throw error;
  }
}

/** The ids a call is about (hashed in the audit record). */
function auditTarget(input: unknown): unknown {
  const value = (input ?? {}) as Record<string, unknown>;
  return {
    assetId: value.assetId,
    assetTag: value.assetTag,
    serial: value.serial,
    licenseId: value.licenseId,
    seatId: value.seatId,
    userId: value.userId,
    targetType: value.targetType,
    targetId: value.targetId,
    kind: value.kind,
    search: value.search,
  };
}

export function registerSnipeItGatewayTools(server: McpServer, client: SnipeItClient): void {
  const read = (tool: string) => readOnly(client, tool);

  server.registerTool(
    'snipeit_search_capabilities',
    {
      title: 'Search Snipe-IT capabilities',
      inputSchema: {
        query: z.string().trim().max(500).default(''),
        limit: z.number().int().min(1).max(50).default(20),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runGatewayTool('snipeit_search_capabilities', input, async () =>
        searchGatewayCapabilities(input.query, input.limit, currentOfferedTools() ?? new Set()),
      ),
  );

  server.registerTool(
    'snipeit_check_connection',
    { title: 'Check Snipe-IT connection', inputSchema: {}, annotations: READ_TOOL_ANNOTATIONS },
    async input => runGatewayTool('snipeit_check_connection', input, () => checkConnection(read('check_connection'))),
  );

  server.registerTool(
    'snipeit_list_assets',
    {
      title: 'List Snipe-IT assets',
      inputSchema: {
        search: text(200).optional(),
        status: z.enum(['RTD', 'Deployed', 'Undeployable', 'Archived', 'Requestable']).optional(),
        statusId: id.optional(),
        modelId: id.optional(),
        categoryId: id.optional(),
        manufacturerId: id.optional(),
        companyId: id.optional(),
        locationId: id.optional(),
        assignedTo: id.optional().describe('Id of the user, asset or location the assets are checked out to.'),
        assignedType: z.enum(['user', 'asset', 'location']).optional().describe('What assignedTo is (default user).'),
        due: z.enum(['audits-due', 'audits-overdue', 'checkins-due', 'checkins-overdue']).optional(),
        ...pageShape,
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input => runGatewayTool('snipeit_list_assets', input, () => listAssets(read('list_assets'), input)),
  );

  server.registerTool(
    'snipeit_get_asset',
    {
      title: 'Get Snipe-IT asset',
      inputSchema: { assetId: id.optional(), assetTag: text(255).optional(), serial: text(255).optional() },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input => runGatewayTool('snipeit_get_asset', input, () => getAsset(read('get_asset'), input)),
  );

  server.registerTool(
    'snipeit_list_licenses',
    {
      title: 'List Snipe-IT licenses',
      inputSchema: {
        search: text(200).optional(),
        categoryId: id.optional(),
        manufacturerId: id.optional(),
        companyId: id.optional(),
        expired: z.boolean().optional().describe('true: only licenses whose expiration date has passed.'),
        ...pageShape,
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input => runGatewayTool('snipeit_list_licenses', input, () => listLicenses(read('list_licenses'), input)),
  );

  server.registerTool(
    'snipeit_get_license',
    {
      title: 'Get Snipe-IT license',
      inputSchema: {
        licenseId: id,
        includeSeats: z.boolean().default(false),
        seatsOffset: z.number().int().min(0).optional(),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input => runGatewayTool('snipeit_get_license', input, () => getLicense(read('get_license'), input)),
  );

  server.registerTool(
    'snipeit_list_accessories',
    { title: 'List Snipe-IT accessories', inputSchema: stockShape, annotations: READ_TOOL_ANNOTATIONS },
    async input => runGatewayTool('snipeit_list_accessories', input, () => listAccessories(read('list_accessories'), input)),
  );

  server.registerTool(
    'snipeit_list_consumables',
    { title: 'List Snipe-IT consumables', inputSchema: stockShape, annotations: READ_TOOL_ANNOTATIONS },
    async input => runGatewayTool('snipeit_list_consumables', input, () => listConsumables(read('list_consumables'), input)),
  );

  server.registerTool(
    'snipeit_list_components',
    { title: 'List Snipe-IT components', inputSchema: stockShape, annotations: READ_TOOL_ANNOTATIONS },
    async input => runGatewayTool('snipeit_list_components', input, () => listComponents(read('list_components'), input)),
  );

  server.registerTool(
    'snipeit_list_users',
    {
      title: 'List Snipe-IT users',
      inputSchema: {
        search: text(200).optional(),
        userId: id.optional(),
        departmentId: id.optional(),
        locationId: id.optional(),
        companyId: id.optional(),
        ...pageShape,
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input => runGatewayTool('snipeit_list_users', input, () => listUsers(read('list_users'), input)),
  );

  server.registerTool(
    'snipeit_list_locations',
    {
      title: 'List Snipe-IT locations',
      inputSchema: { search: text(200).optional(), parentId: id.optional(), ...pageShape },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input => runGatewayTool('snipeit_list_locations', input, () => listLocations(read('list_locations'), input)),
  );

  server.registerTool(
    'snipeit_list_reference_data',
    {
      title: 'List Snipe-IT reference data',
      inputSchema: { kind: z.enum(REFERENCE_KINDS), search: text(200).optional(), ...pageShape },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runGatewayTool('snipeit_list_reference_data', input, () => listReferenceData(read('list_reference_data'), input)),
  );

  server.registerTool(
    'snipeit_get_activity_report',
    {
      title: 'Get Snipe-IT activity report',
      inputSchema: {
        itemType: z.enum(['asset', 'license', 'accessory', 'consumable', 'component', 'user', 'location']).optional(),
        itemId: id.optional(),
        actionType: text(50).optional().describe('e.g. checkout, "checkin from", update, "create new", audit'),
        targetType: z.enum(['user', 'asset', 'location']).optional(),
        targetId: id.optional(),
        limit: z.number().int().min(1).max(GATEWAY_MAX_LIMIT).optional().describe('Entries (default 25, at most 100).'),
        offset: z.number().int().min(0).optional(),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runGatewayTool('snipeit_get_activity_report', input, () => getActivityReport(read('get_activity_report'), input)),
  );

  server.registerTool(
    'snipeit_create_asset',
    {
      title: 'Create Snipe-IT asset',
      inputSchema: {
        modelId: id.describe('Model id (list_reference_data kind=models).'),
        statusId: id.describe('Status label id (list_reference_data kind=statuslabels).'),
        assetTag: text(255).optional().describe('Required unless Snipe-IT numbers asset tags itself.'),
        serial: text(255).optional(),
        name: assetFieldsShape.name,
        companyId: id.optional(),
        locationId: assetFieldsShape.locationId,
        defaultLocationId: assetFieldsShape.defaultLocationId,
        supplierId: id.optional(),
        orderNumber: assetFieldsShape.orderNumber,
        purchaseDate: assetFieldsShape.purchaseDate,
        purchaseCost: z.number().min(0).max(1_000_000_000).optional(),
        warrantyMonths: assetFieldsShape.warrantyMonths,
        notes: assetFieldsShape.notes,
        requestable: z.boolean().optional(),
      },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input => runGatewayTool('snipeit_create_asset', input, () => createAsset(client, input)),
  );

  server.registerTool(
    'snipeit_update_asset',
    {
      title: 'Update Snipe-IT asset',
      inputSchema: { assetId: id, ...assetFieldsShape },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input => runGatewayTool('snipeit_update_asset', input, () => updateAsset(client, input)),
  );

  server.registerTool(
    'snipeit_checkout_asset',
    {
      title: 'Check out Snipe-IT asset',
      inputSchema: {
        assetId: id,
        targetType: z.enum(['user', 'location', 'asset']).default('user'),
        targetId: id,
        expectedCheckin: date.optional(),
        statusId: id.optional(),
        note: z.string().trim().max(10_000).optional(),
      },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input => runGatewayTool('snipeit_checkout_asset', input, () => checkoutAsset(client, input)),
  );

  server.registerTool(
    'snipeit_checkin_asset',
    {
      title: 'Check in Snipe-IT asset',
      inputSchema: {
        assetId: id,
        locationId: id.optional(),
        statusId: id.optional(),
        note: z.string().trim().max(10_000).optional(),
      },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input => runGatewayTool('snipeit_checkin_asset', input, () => checkinAsset(client, input)),
  );

  server.registerTool(
    'snipeit_audit_asset',
    {
      title: 'Audit Snipe-IT asset',
      inputSchema: {
        assetId: id,
        locationId: id.optional(),
        nextAuditDate: date.optional(),
        note: z.string().trim().max(10_000).optional(),
      },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input => runGatewayTool('snipeit_audit_asset', input, () => auditAsset(client, input)),
  );

  server.registerTool(
    'snipeit_checkout_license_seat',
    {
      title: 'Assign Snipe-IT license seat',
      inputSchema: {
        licenseId: id,
        seatId: id,
        targetType: z.enum(['user', 'asset']).default('user'),
        targetId: id,
        note: z.string().trim().max(10_000).optional(),
      },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input => runGatewayTool('snipeit_checkout_license_seat', input, () => checkoutLicenseSeat(client, input)),
  );

  server.registerTool(
    'snipeit_checkin_license_seat',
    {
      title: 'Free Snipe-IT license seat',
      inputSchema: { licenseId: id, seatId: id, note: z.string().trim().max(10_000).optional() },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input => runGatewayTool('snipeit_checkin_license_seat', input, () => checkinLicenseSeat(client, input)),
  );
}
