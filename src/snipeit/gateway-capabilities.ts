import type { SnipeItCapability } from './capabilities.js';

/**
 * Discovery for the embedded gateway (search_capabilities): its own tools
 * only, never the MCP server's generic entity tools or its enrollment tools.
 */

/** The gateway runs as the Snipe-IT user who owns the API key. */
export const TOKEN_USER_NOTE =
  'Runs as the Snipe-IT user who owns the API key; Snipe-IT applies that user’s permissions and records changes as theirs.';

const LIST_NOTE = 'Lists return {total, rows}; page with limit (at most 100) and offset.';

export const GATEWAY_CAPABILITIES: readonly SnipeItCapability[] = [
  {
    id: 'snipeit_search_capabilities',
    title: 'Search Snipe-IT capabilities',
    description: 'Find the Snipe-IT tool for assets, licenses, accessories, users, locations or check-in/out.',
    risk: 'read',
    examples: [{ query: 'checkout laptop' }],
    identifierFormats: [],
    safetyNotes: ['Discovery only. Does not call Snipe-IT.'],
    keywords: ['discover', 'help', 'capabilities', 'hjælp'],
  },
  {
    id: 'snipeit_check_connection',
    title: 'Check Snipe-IT connection',
    description: 'Verify that Snipe-IT accepts the API key, and show the user it belongs to.',
    risk: 'read',
    examples: [{}],
    identifierFormats: [],
    safetyNotes: [TOKEN_USER_NOTE],
    keywords: ['connection', 'forbindelse', 'whoami', 'me', 'identity', 'hvem'],
  },
  {
    id: 'snipeit_list_assets',
    title: 'List assets (Snipe-IT)',
    description: 'Search and filter hardware assets by status, model, category, location or assignee; or list assets due for audit or check-in.',
    risk: 'read',
    examples: [{ search: 'laptop', status: 'Deployed' }, { due: 'audits-overdue' }],
    identifierFormats: ['Ids are numbers; status is RTD, Deployed, Undeployable, Archived or Requestable.'],
    safetyNotes: [LIST_NOTE, 'Custom fields are not returned.'],
    keywords: ['assets', 'hardware', 'udstyr', 'computer', 'laptop', 'pc', 'aktiver', 'audit', 'due'],
  },
  {
    id: 'snipeit_get_asset',
    title: 'Get asset (Snipe-IT)',
    description: 'Fetch one asset by id, asset tag or serial number.',
    risk: 'read',
    examples: [{ assetTag: 'LAP-0042' }, { serial: 'C02XK1ABJGH5' }],
    identifierFormats: ['assetId (number), assetTag or serial (text): exactly one.'],
    safetyNotes: ['Custom fields are not returned.'],
    keywords: ['asset', 'tag', 'serial', 'serienummer', 'udstyr'],
  },
  {
    id: 'snipeit_list_licenses',
    title: 'List licenses (Snipe-IT)',
    description: 'List software licenses with seats and expiry; optionally only expired ones.',
    risk: 'read',
    examples: [{ search: 'Office' }, { expired: true }],
    identifierFormats: [],
    safetyNotes: [LIST_NOTE, 'Product keys are never returned.'],
    keywords: ['licenses', 'licenser', 'software', 'seats', 'expiry', 'udløb'],
  },
  {
    id: 'snipeit_get_license',
    title: 'Get license (Snipe-IT)',
    description: 'Fetch one license, optionally with its seats (who or what holds each seat).',
    risk: 'read',
    examples: [{ licenseId: 3, includeSeats: true }],
    identifierFormats: ['licenseId (number); seat ids come from includeSeats.'],
    safetyNotes: ['Product keys are never returned.'],
    keywords: ['license', 'licens', 'seats', 'pladser'],
  },
  {
    id: 'snipeit_list_accessories',
    title: 'List accessories (Snipe-IT)',
    description: 'List accessories (keyboards, mice, cables) with quantities.',
    risk: 'read',
    examples: [{ search: 'mouse' }],
    identifierFormats: [],
    safetyNotes: [LIST_NOTE],
    keywords: ['accessories', 'tilbehør', 'mus', 'tastatur', 'kabel'],
  },
  {
    id: 'snipeit_list_consumables',
    title: 'List consumables (Snipe-IT)',
    description: 'List consumables (toner, paper) with quantities left.',
    risk: 'read',
    examples: [{ search: 'toner' }],
    identifierFormats: [],
    safetyNotes: [LIST_NOTE],
    keywords: ['consumables', 'forbrugsvarer', 'toner', 'papir', 'stock', 'lager'],
  },
  {
    id: 'snipeit_list_components',
    title: 'List components (Snipe-IT)',
    description: 'List components (RAM, disks) with quantities left.',
    risk: 'read',
    examples: [{ search: 'SSD' }],
    identifierFormats: [],
    safetyNotes: [LIST_NOTE],
    keywords: ['components', 'komponenter', 'ram', 'disk', 'ssd'],
  },
  {
    id: 'snipeit_list_users',
    title: 'List users (Snipe-IT)',
    description: 'Search users, or fetch one by userId: name, user name, mail, department, location and counts of what is assigned.',
    risk: 'read',
    examples: [{ search: 'jensen' }, { userId: 12 }],
    identifierFormats: ['userId (number).'],
    safetyNotes: [LIST_NOTE, 'Phone numbers, addresses and employee numbers are not returned.'],
    keywords: ['users', 'brugere', 'medarbejder', 'person', 'employee'],
  },
  {
    id: 'snipeit_list_locations',
    title: 'List locations (Snipe-IT)',
    description: 'List or search locations, with counts of assets and users.',
    risk: 'read',
    examples: [{ search: 'lager' }],
    identifierFormats: [],
    safetyNotes: [LIST_NOTE],
    keywords: ['locations', 'placering', 'lokation', 'kontor', 'site'],
  },
  {
    id: 'snipeit_list_reference_data',
    title: 'List Snipe-IT reference data',
    description: 'Models, categories, manufacturers, status labels, suppliers or departments: the valid ids for filters and changes.',
    risk: 'read',
    examples: [{ kind: 'statuslabels' }, { kind: 'models', search: 'ThinkPad' }],
    identifierFormats: ['kind: models, categories, manufacturers, statuslabels, suppliers or departments.'],
    safetyNotes: [LIST_NOTE],
    keywords: ['models', 'modeller', 'categories', 'kategorier', 'status', 'manufacturers', 'producenter', 'suppliers', 'leverandører', 'departments', 'afdelinger'],
  },
  {
    id: 'snipeit_get_activity_report',
    title: 'Get activity report (Snipe-IT)',
    description: 'Recent activity: checkouts, checkins, updates and audits, newest first, filterable by item, action or target.',
    risk: 'read',
    examples: [{ itemType: 'asset', itemId: 42 }, { actionType: 'checkout', limit: 10 }],
    identifierFormats: ['itemType: asset, license, accessory, consumable, component, user or location.'],
    safetyNotes: [LIST_NOTE, 'At most 100 entries per call; IP addresses and change details are not returned.'],
    keywords: ['activity', 'aktivitet', 'history', 'historik', 'log', 'who'],
  },
  {
    id: 'snipeit_create_asset',
    title: 'Create asset (Snipe-IT)',
    description: 'Create a hardware asset from a model and a status label.',
    risk: 'write',
    examples: [{ modelId: 4, statusId: 2, assetTag: 'LAP-0100', serial: 'C02XK1ABJGH5' }],
    identifierFormats: ['modelId and statusId from list_reference_data.'],
    safetyNotes: [TOKEN_USER_NOTE],
    keywords: ['create', 'opret', 'new', 'ny', 'asset', 'udstyr'],
  },
  {
    id: 'snipeit_update_asset',
    title: 'Update asset (Snipe-IT)',
    description: 'Change an asset’s name, status, location, default location, notes, order number, purchase date or warranty.',
    risk: 'write',
    examples: [{ assetId: 42, statusId: 3, notes: 'Skærm revnet.' }],
    identifierFormats: ['assetId (number).'],
    safetyNotes: [TOKEN_USER_NOTE, 'Only the fields given change.'],
    keywords: ['update', 'opdater', 'ret', 'status', 'notes', 'noter'],
  },
  {
    id: 'snipeit_checkout_asset',
    title: 'Check out asset (Snipe-IT)',
    description: 'Check an asset out to a user, a location or another asset.',
    risk: 'write',
    examples: [{ assetId: 42, targetType: 'user', targetId: 12 }],
    identifierFormats: ['assetId and targetId (numbers).'],
    safetyNotes: [TOKEN_USER_NOTE, 'Snipe-IT may send the user a checkout mail, depending on its settings.'],
    keywords: ['checkout', 'udlever', 'udlån', 'assign', 'tildel'],
  },
  {
    id: 'snipeit_checkin_asset',
    title: 'Check in asset (Snipe-IT)',
    description: 'Check an asset back in, optionally setting its location and status.',
    risk: 'write',
    examples: [{ assetId: 42 }],
    identifierFormats: ['assetId (number).'],
    safetyNotes: [TOKEN_USER_NOTE],
    keywords: ['checkin', 'aflever', 'retur', 'return'],
  },
  {
    id: 'snipeit_audit_asset',
    title: 'Audit asset (Snipe-IT)',
    description: 'Record a physical audit of an asset, optionally with location and next audit date.',
    risk: 'write',
    examples: [{ assetId: 42, nextAuditDate: '2027-11-20' }],
    identifierFormats: ['assetId (number); dates YYYY-MM-DD.'],
    safetyNotes: [TOKEN_USER_NOTE, 'An audit is a log entry; it cannot be removed afterwards.'],
    keywords: ['audit', 'optælling', 'kontrol', 'inventory'],
  },
  {
    id: 'snipeit_checkout_license_seat',
    title: 'Assign license seat (Snipe-IT)',
    description: 'Assign one seat of a license to a user or an asset.',
    risk: 'write',
    examples: [{ licenseId: 3, seatId: 17, targetType: 'user', targetId: 12 }],
    identifierFormats: ['seatId from get_license with includeSeats.'],
    safetyNotes: [TOKEN_USER_NOTE],
    keywords: ['license', 'licens', 'seat', 'tildel', 'assign'],
  },
  {
    id: 'snipeit_checkin_license_seat',
    title: 'Free license seat (Snipe-IT)',
    description: 'Free one seat of a license.',
    risk: 'write',
    examples: [{ licenseId: 3, seatId: 17 }],
    identifierFormats: ['seatId from get_license with includeSeats.'],
    safetyNotes: [TOKEN_USER_NOTE, 'On a license that is not reassignable, a freed seat cannot be used again.'],
    keywords: ['license', 'licens', 'seat', 'frigiv', 'release'],
  },
];

/** The gateway capabilities the instance offers that match the query, best first. */
export function searchGatewayCapabilities(query: string, limit: number, offered: ReadonlySet<string>): SnipeItCapability[] {
  const pool = GATEWAY_CAPABILITIES.filter(capability => offered.has(capability.id));
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) {
    return pool.slice(0, limit);
  }
  return pool
    .map(capability => {
      const haystack = [capability.id, capability.title, capability.description, ...capability.identifierFormats, ...capability.keywords]
        .join(' ')
        .toLowerCase();
      return { capability, score: terms.filter(term => haystack.includes(term)).length };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.capability.id.localeCompare(b.capability.id))
    .slice(0, limit)
    .map(item => item.capability);
}
