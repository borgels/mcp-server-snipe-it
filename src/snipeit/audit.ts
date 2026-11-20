import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { formatUnknownError } from '../errors.js';
import { withheldAuditRecord } from '../fallbacks.js';
import { leaksSecret } from '../key-admission.js';
import { redactDeep } from '../redaction.js';
import { currentCallContext, currentInstancePolicy, currentRedactor, type AuditSink } from './scope.js';

export interface SnipeItAuditEvent {
  requestId?: string;
  tool: string;
  action: 'start' | 'finish' | 'error' | 'policy_denied' | 'rejected';
  target?: unknown;
  status?: string;
  reason?: string;
  error?: unknown;
  /**
   * Gateway-verified caller (X-MCP-User). Recorded in the clear: an audit trail
   * that cannot name the actor is not an audit trail, and this is the only place
   * attribution exists when the connector runs on a shared token — Snipe-IT's
   * own action log then credits every change to the token's owner instead.
   * (MCP server only; an embedded gateway records its caller as a pseudonym.)
   */
  user?: string;
}

/**
 * The audit's code for an error in a gateway call: the HTTP status of a
 * Snipe-IT error, `timeout`, or `error`. Only codes from this fixed set are
 * written; the error's message never is.
 */
export function auditErrorCode(error: unknown): string {
  const status = (error as { status?: unknown } | null)?.status;
  if (error instanceof Error && error.name === 'SnipeItHttpError' && typeof status === 'number' && Number.isInteger(status)) {
    return `http_${status}`;
  }
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return 'timeout';
  return 'error';
}

/** The key of the caller pseudonyms: random per process, never written anywhere. */
const CALLER_KEY = randomBytes(32);

/** The caller as `hmac:` and 16 hex characters: the same caller gives the same pseudonym within the process. */
export function callerPseudonym(caller: string | undefined): string | undefined {
  if (caller === undefined || caller === '') return undefined;
  return `hmac:${createHmac('sha256', CALLER_KEY).update(caller, 'utf8').digest('hex').slice(0, 16)}`;
}

/**
 * Append one JSON line to SNIPEIT_AUDIT_LOG (no-op when unset). Inside a
 * gateway call (always under an InstancePolicy) the record goes to the
 * policy's `audit` sink instead (no-op without one), SNIPEIT_AUDIT_LOG is not
 * read, the caller is written only as a pseudonym and an error only as a
 * fixed code. A failing sink or file throws, so a tool whose start record
 * cannot be written does not run.
 */
export async function writeAuditEvent(event: SnipeItAuditEvent): Promise<void> {
  const hosted = currentInstancePolicy();
  if (hosted) {
    await writeHostedAuditEvent(event, hosted.audit);
    return;
  }

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

async function writeHostedAuditEvent(event: SnipeItAuditEvent, sink: AuditSink | undefined): Promise<void> {
  if (!sink) {
    return;
  }
  const context = currentCallContext();
  const record = {
    timestamp: new Date().toISOString(),
    // The gateway's own id for the call; the host's request id is its text and is not written.
    requestId: context.requestId ?? randomUUID(),
    tool: event.tool,
    // Only as a pseudonym: the caller is the host's text, often a mail address.
    caller: callerPseudonym(context.caller),
    action: event.action,
    targetHash: event.target === undefined ? undefined : hashValue(JSON.stringify(event.target)),
    status: event.status,
    reason: event.reason,
    // A fixed code, never the error's message.
    error: event.error === undefined ? undefined : auditErrorCode(event.error),
  };
  // Redacted (the call scope's redactor, numbers and depth included), then copied through JSON: plain data, without
  // undefined fields. The second pass is the final one, over the assembled record.
  const redactor = currentRedactor();
  const safe = JSON.parse(JSON.stringify(redactDeep(redactDeep(record, redactor), redactor))) as Record<string, unknown>;
  // The sink check (src/key-admission.ts), on the record in its final form.
  await sink(redactor !== undefined && leaksSecret(safe, redactor) ? withheldAuditRecord() : safe);
}

function hashValue(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
