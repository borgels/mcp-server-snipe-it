import { createHash, randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { formatUnknownError } from '../errors.js';

export interface SnipeItAuditEvent {
  requestId?: string;
  tool: string;
  action: 'start' | 'finish' | 'error' | 'policy_denied';
  target?: unknown;
  status?: string;
  reason?: string;
  error?: unknown;
  /**
   * Gateway-verified caller (X-MCP-User). Recorded in the clear: an audit trail
   * that cannot name the actor is not an audit trail, and this is the only place
   * attribution exists when the connector runs on a shared token — Snipe-IT's
   * own action log then credits every change to the token's owner instead.
   */
  user?: string;
}

export async function writeAuditEvent(event: SnipeItAuditEvent): Promise<void> {
  const auditPath = process.env.SNIPEIT_AUDIT_LOG;
  if (!auditPath) {
    return;
  }

  const record = {
    timestamp: new Date().toISOString(),
    requestId: event.requestId ?? randomUUID(),
    tool: event.tool,
    action: event.action,
    user: event.user,
    targetHash: event.target === undefined ? undefined : hashValue(JSON.stringify(event.target)),
    status: event.status,
    reason: event.reason,
    error: event.error === undefined ? undefined : formatUnknownError(event.error),
  };

  await appendFile(auditPath, `${JSON.stringify(record)}\n`, 'utf8');
}

function hashValue(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
