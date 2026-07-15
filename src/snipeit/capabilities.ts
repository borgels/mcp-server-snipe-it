export type CapabilityRisk = 'read' | 'write';

export interface SnipeItCapability {
  id: string;
  title: string;
  description: string;
  risk: CapabilityRisk;
  examples: unknown[];
  identifierFormats: string[];
  safetyNotes: string[];
  keywords: string[];
}

export const READ_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export const WRITE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

const PAGINATION_NOTE = 'Lists return {total, rows}; page with limit/offset until offset >= total (server caps limit at 500).';

export const SNIPEIT_CAPABILITIES: SnipeItCapability[] = [
  {
    id: 'snipeit_search_capabilities',
    title: 'Search Snipe-IT Capabilities',
    description: 'Find the Snipe-IT MCP tool to use for assets, licenses, users, or check-in/out.',
    risk: 'read',
    examples: [{ query: 'checkout laptop' }],
    identifierFormats: ['Tool id such as snipeit_list_assets or snipeit_checkout.'],
    safetyNotes: ['Discovery only. Does not call Snipe-IT.'],
    keywords: ['discover', 'help', 'capabilities'],
  },
  {
    id: 'snipeit_list_assets',
    title: 'List Assets (Snipe-IT)',
    description:
      'Search/list hardware assets with filters: free-text search, meta-status (RTD/Deployed/…), status label, model, category, manufacturer, company, location, assignee. Also lists assets due/overdue for audit or check-in.',
    risk: 'read',
    examples: [{ search: 'macbook' }, { status: 'Deployed', locationId: 3 }, { due: 'audits-overdue' }],
    identifierFormats: ['Numeric ids for model/category/…', 'status: RTD | Deployed | Undeployable | Deleted | Archived | Requestable'],
    safetyNotes: [PAGINATION_NOTE],
    keywords: ['assets', 'hardware', 'udstyr', 'laptops', 'search', 'inventory', 'aktiver'],
  },
  {
    id: 'snipeit_get_asset',
    title: 'Get Asset (Snipe-IT)',
    description:
      'Fetch one asset by id, asset tag, or serial number. include can fetch its licenses, full history, or assigned child assets/accessories/components.',
    risk: 'read',
    examples: [{ assetTag: 'BOS-0042' }, { id: 17, include: 'history' }],
    identifierFormats: ['id (number)', 'assetTag (string)', 'serial (string)'],
    safetyNotes: [],
    keywords: ['asset', 'tag', 'serial', 'history', 'details'],
  },
  {
    id: 'snipeit_list_entities',
    title: 'List Entities (Snipe-IT)',
    description:
      'List any other entity type: licenses, accessories, consumables, components, users, locations, status labels, categories, manufacturers, models, companies, departments, suppliers, custom fields, fieldsets, kits, maintenances, depreciations, groups.',
    risk: 'read',
    examples: [{ entity: 'licenses' }, { entity: 'users', search: 'anders' }],
    identifierFormats: ['entity: one of the listed type names'],
    safetyNotes: [PAGINATION_NOTE],
    keywords: ['licenses', 'licenser', 'accessories', 'tilbehør', 'consumables', 'users', 'brugere', 'locations', 'lokationer', 'models'],
  },
  {
    id: 'snipeit_get_entity',
    title: 'Get Entity (Snipe-IT)',
    description:
      'Fetch one entity by id, optionally a subresource: license seats, accessory checkedout rows, component assets, user assets/accessories/licenses, location assets, histories.',
    risk: 'read',
    examples: [{ entity: 'licenses', id: 5, include: 'seats' }, { entity: 'users', id: 12, include: 'assets' }],
    identifierFormats: ['include values depend on entity — the error message lists the valid ones'],
    safetyNotes: ['Accessory/component pivot-row ids for checkin come from include=checkedout / include=assets.'],
    keywords: ['seats', 'sæder', 'checkedout', 'user assets', 'detail'],
  },
  {
    id: 'snipeit_get_activity_report',
    title: 'Get Activity Report (Snipe-IT)',
    description: 'The audit trail: who checked what in/out, created, updated, deleted — filterable by item, action, and target.',
    risk: 'read',
    examples: [{ itemType: 'asset', itemId: 17 }, { actionType: 'checkout' }],
    identifierFormats: ['actionType: checkout, checkin from, update, create new, delete, audit, …'],
    safetyNotes: [PAGINATION_NOTE],
    keywords: ['activity', 'log', 'audit trail', 'historik', 'hvem', 'report'],
  },
  {
    id: 'snipeit_create_asset',
    title: 'Create Asset (Snipe-IT)',
    description: 'Create a hardware asset. Requires at minimum model_id and status_id; asset_tag unless auto-increment is on.',
    risk: 'write',
    examples: [{ payload: { model_id: 3, status_id: 2, asset_tag: 'BOS-0100', serial: 'C02XX' } }],
    identifierFormats: ['payload uses Snipe-IT API field names (snake_case)'],
    safetyNotes: ['Requires SNIPEIT_ENABLE_WRITES=true.'],
    keywords: ['create', 'opret', 'asset', 'new hardware', 'registrer'],
  },
  {
    id: 'snipeit_update_asset',
    title: 'Update Asset (Snipe-IT)',
    description: 'Partially update an asset (PATCH — only the fields you send change).',
    risk: 'write',
    examples: [{ id: 17, patch: { notes: 'Skærm skiftet' } }],
    identifierFormats: [],
    safetyNotes: ['Requires SNIPEIT_ENABLE_WRITES=true.'],
    keywords: ['update', 'ret', 'edit', 'asset', 'notes'],
  },
  {
    id: 'snipeit_create_entity',
    title: 'Create Entity (Snipe-IT)',
    description: 'Create a non-asset entity: user, license, accessory, consumable, component, location, category, model, supplier, maintenance, etc.',
    risk: 'write',
    examples: [{ entity: 'users', payload: { first_name: 'Ny', last_name: 'Medarbejder', username: 'nym' } }],
    identifierFormats: ['payload uses Snipe-IT API field names (snake_case)'],
    safetyNotes: ['Requires SNIPEIT_ENABLE_WRITES=true.'],
    keywords: ['create', 'opret', 'user', 'license', 'location', 'new'],
  },
  {
    id: 'snipeit_update_entity',
    title: 'Update Entity (Snipe-IT)',
    description: 'Partially update a non-asset entity (PATCH).',
    risk: 'write',
    examples: [{ entity: 'licenses', id: 5, patch: { seats: 25 } }],
    identifierFormats: [],
    safetyNotes: ['Requires SNIPEIT_ENABLE_WRITES=true.'],
    keywords: ['update', 'ret', 'edit', 'license seats'],
  },
  {
    id: 'snipeit_checkout',
    title: 'Check Out (Snipe-IT)',
    description:
      'Check out an asset (to user/asset/location), accessory (to user), consumable (to user — IRREVERSIBLE), component (to asset), or license seat (to user/asset).',
    risk: 'write',
    examples: [
      { type: 'asset', id: 17, targetType: 'user', targetId: 12 },
      { type: 'license', id: 5, targetType: 'user', targetId: 12 },
    ],
    identifierFormats: ['type: asset | accessory | consumable | component | license'],
    safetyNotes: [
      'Requires SNIPEIT_ENABLE_WRITES=true.',
      'Consumable checkout cannot be undone — stock only decrements. Confirm with the user first.',
      'Asset must be in a deployable status label, otherwise Snipe-IT refuses.',
    ],
    keywords: ['checkout', 'udlevér', 'assign', 'tildel', 'udlån'],
  },
  {
    id: 'snipeit_checkin',
    title: 'Check In (Snipe-IT)',
    description:
      'Check in an asset, accessory, component, or license seat. NOTE: for accessories/components the id is the PIVOT-ROW id from snipeit_get_entity include=checkedout / include=assets — not the entity id.',
    risk: 'write',
    examples: [{ type: 'asset', id: 17 }, { type: 'license', id: 5, seatId: 42 }],
    identifierFormats: ['license checkin requires seatId'],
    safetyNotes: [
      'Requires SNIPEIT_ENABLE_WRITES=true.',
      'Checking in a seat on a NON-reassignable license permanently burns the seat — check the license first.',
    ],
    keywords: ['checkin', 'aflevér', 'return', 'retur', 'indlevér'],
  },
  {
    id: 'snipeit_audit_asset',
    title: 'Audit Asset (Snipe-IT)',
    description: 'Record a physical audit of an asset (append-only log entry, optionally sets location and next audit date).',
    risk: 'write',
    examples: [{ id: 17, note: 'Set på kontoret', nextAuditDate: '2027-01-01' }],
    identifierFormats: [],
    safetyNotes: ['Requires SNIPEIT_ENABLE_WRITES=true. Audit entries cannot be deleted via the API.'],
    keywords: ['audit', 'optælling', 'inventory check', 'fysisk'],
  },
];

export function searchCapabilities(query: string, limit = 20): SnipeItCapability[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return SNIPEIT_CAPABILITIES.slice(0, limit);
  }
  return SNIPEIT_CAPABILITIES.map(capability => ({
    capability,
    score: scoreCapability(capability, normalized),
  }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.capability.id.localeCompare(b.capability.id))
    .slice(0, limit)
    .map(item => item.capability);
}

function scoreCapability(capability: SnipeItCapability, query: string): number {
  const haystack = [
    capability.id,
    capability.title,
    capability.description,
    ...capability.identifierFormats,
    ...capability.keywords,
  ]
    .join(' ')
    .toLowerCase();
  return query
    .split(/\s+/)
    .filter(Boolean)
    .reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}
