/**
 * Read tools are always on. Write tools require SNIPEIT_ENABLE_WRITES=true
 * on the instance. There are deliberately NO delete tools: most Snipe-IT
 * entities have no API restore, so deletion is irreversible — if that is
 * ever needed it belongs behind a dedicated duty-gated tool, not here.
 */
export function writesEnabled(): boolean {
  return process.env.SNIPEIT_ENABLE_WRITES === 'true';
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

export function checkToolPolicy(toolName: string): SnipeItPolicyDecision {
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
