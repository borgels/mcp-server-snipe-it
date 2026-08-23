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

export function checkToolPolicy(toolName: string): SnipeItPolicyDecision {
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
