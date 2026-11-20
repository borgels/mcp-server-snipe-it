import { currentInstancePolicy } from './scope.js';

/**
 * Read tools are always on. Write tools require SNIPEIT_ENABLE_WRITES=true
 * on the instance. There are deliberately NO delete tools: most Snipe-IT
 * entities have no API restore, so deletion is irreversible — if that is
 * ever needed it belongs behind a dedicated duty-gated tool, not here.
 */
export function writesEnabled(): boolean {
  return process.env.SNIPEIT_ENABLE_WRITES === 'true';
}

/**
 * Per-user auth. When on, the server holds NO shared credential for data calls:
 * each user enrols their own Snipe-IT personal access token, so they act as
 * themselves with their own Snipe-IT permissions and appear correctly in
 * Snipe-IT's own action log.
 *
 * There is deliberately no fallback to SNIPEIT_API_TOKEN in this mode. A
 * fallback would silently hand an un-enrolled user whatever rights the shared
 * token has — the exact failure this mode exists to remove.
 *
 * Off (the default) keeps the original single-shared-token behaviour, which is
 * what stdio/local use and single-operator deployments want.
 */
export function perUserAuthEnabled(): boolean {
  return process.env.SNIPEIT_PER_USER_AUTH === 'true';
}

/** Only trust X-MCP-User when told to — it is an identity assertion. */
export function trustForwardedUser(): boolean {
  return process.env.SNIPEIT_TRUST_FORWARDED_USER === 'true';
}

/**
 * Per-user isolation: in per-user mode every tool needs the gateway-verified
 * identity. Without it the server refuses rather than falling back to a shared
 * identity — nobody gets anonymous or borrowed access to Snipe-IT.
 */
export function requireUser(onBehalfOf: string | undefined): string {
  if (!onBehalfOf) {
    throw new Error(
      'No verified user identity. In per-user mode this connector only works behind a gateway that forwards the ' +
        'signed-in user (X-MCP-User) and has SNIPEIT_TRUST_FORWARDED_USER=true. Each user acts as their own ' +
        'Snipe-IT account.',
    );
  }
  return onBehalfOf;
}

export function assertWritesEnabled(action: string): void {
  if (!writesEnabled()) {
    throw new Error(
      `Write access is disabled on this Snipe-IT MCP instance (${action}). ` +
        'Set SNIPEIT_ENABLE_WRITES=true in the server environment to allow write tools.',
    );
  }
}

export interface SnipeItPolicyDecision {
  allowed: boolean;
  reason: string;
}

const READ_TOOLS = new Set([
  'snipeit_search_capabilities',
  'snipeit_list_assets',
  'snipeit_get_asset',
  'snipeit_list_entities',
  'snipeit_get_entity',
  'snipeit_get_activity_report',
]);

const WRITE_TOOLS = new Set([
  'snipeit_create_entity',
  'snipeit_update_entity',
  'snipeit_create_asset',
  'snipeit_update_asset',
  'snipeit_checkout',
  'snipeit_checkin',
  'snipeit_audit_asset',
]);

/**
 * Credential-management tools. Always allowed, regardless of
 * SNIPEIT_ENABLE_WRITES: they only touch this server's own encrypted token
 * store, never Snipe-IT data, and gating them behind writes would make a
 * read-only instance impossible to enrol into.
 */
const AUTH_TOOLS = new Set(['snipeit_connect', 'snipeit_status', 'snipeit_disconnect']);

/** The embedded gateway's tools (prefixed names), and which of them change data in Snipe-IT. */
export const GATEWAY_READ_TOOLS: ReadonlySet<string> = new Set([
  'snipeit_search_capabilities',
  'snipeit_check_connection',
  'snipeit_list_assets',
  'snipeit_get_asset',
  'snipeit_list_licenses',
  'snipeit_get_license',
  'snipeit_list_accessories',
  'snipeit_list_consumables',
  'snipeit_list_components',
  'snipeit_list_users',
  'snipeit_list_locations',
  'snipeit_list_reference_data',
  'snipeit_get_activity_report',
]);

export const GATEWAY_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'snipeit_create_asset',
  'snipeit_update_asset',
  'snipeit_checkout_asset',
  'snipeit_checkin_asset',
  'snipeit_audit_asset',
  'snipeit_checkout_license_seat',
  'snipeit_checkin_license_seat',
]);

/**
 * Inside a gateway call (always under an InstancePolicy, src/snipeit/scope.ts)
 * no environment variable is read: a tool the host disabled is refused, and a
 * write tool runs only when the host enabled writes.
 */
function checkHostedToolPolicy(toolName: string): SnipeItPolicyDecision {
  const hosted = currentInstancePolicy()!;
  if (hosted.disabledTools.has(toolName)) {
    return { allowed: false, reason: `tool is disabled on this instance by the embedding host: ${toolName}` };
  }
  if (GATEWAY_READ_TOOLS.has(toolName)) {
    return { allowed: true, reason: 'read tool' };
  }
  if (GATEWAY_WRITE_TOOLS.has(toolName)) {
    return hosted.enableWrites
      ? { allowed: true, reason: 'writes enabled by the embedding host' }
      : { allowed: false, reason: 'writes are disabled. The embedding host has not enabled writes for this instance.' };
  }
  return { allowed: false, reason: 'tool is not a gateway tool.' };
}

export function checkToolPolicy(toolName: string): SnipeItPolicyDecision {
  if (currentInstancePolicy()) {
    return checkHostedToolPolicy(toolName);
  }
  if (AUTH_TOOLS.has(toolName)) {
    return { allowed: true, reason: 'credential management (local token store only)' };
  }
  if (READ_TOOLS.has(toolName)) {
    return { allowed: true, reason: 'read-only Snipe-IT tool' };
  }
  if (WRITE_TOOLS.has(toolName)) {
    if (!writesEnabled()) {
      return {
        allowed: false,
        reason: `write tool is disabled on this instance (SNIPEIT_ENABLE_WRITES != true): ${toolName}`,
      };
    }
    return { allowed: true, reason: 'write tool (writes enabled on this instance)' };
  }
  return { allowed: false, reason: `tool is not allowlisted: ${toolName}` };
}
