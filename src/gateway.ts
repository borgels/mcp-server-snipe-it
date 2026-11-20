import { randomUUID } from 'node:crypto';
import { z } from 'zod/v4';
import { fixedOutputs, withheldResult } from './fallbacks.js';
import { admitsKey, KEY_REFUSED, leaksSecret, maskedText, sealedError } from './key-admission.js';
import { redactDeep, redactText } from './redaction.js';
import { normalizeSnipeItBaseUrl } from './snipeit/address.js';
import { writeAuditEvent } from './snipeit/audit.js';
import { SnipeItClient, type SnipeItClientOptions } from './snipeit/client.js';
import type { ResolveHost } from './snipeit/network.js';
import {
  canonicalToolName,
  GatewayConfigError,
  resolveInstancePolicy,
  runInCallScope,
  TOOL_PREFIX,
  type CallContext,
  type InstancePolicy,
  type ResolvedInstancePolicy,
} from './snipeit/scope.js';
import { registerSnipeItGatewayTools } from './tools/gateway-tools.js';
import { SecretRedactor } from './upstream-http.js';

/**
 * Embeddable entry point (package export `./gateway`): an embedding host,
 * such as an MCP gateway that does its own per-user authorization, lists
 * `tools` and invokes `callTool`. Schemas, handlers, policy checks and audit
 * live in src/tools/gateway-tools.ts and src/snipeit/gateway-ops.ts.
 *
 * Several gateway instances (for example one per tenant) can run in one
 * process. Each instance uses only the API key and the Snipe-IT address
 * passed to createSnipeItGateway and reads no SNIPEIT_* variable at all: not
 * the key (SNIPEIT_API_TOKEN), not the address (SNIPEIT_BASE_URL), not
 * SNIPEIT_TIMEOUT_MS (30 seconds unless `timeoutMs` is given), not
 * SNIPEIT_ENABLE_WRITES (the host's policy decides), not the per-user mode
 * and its token store (SNIPEIT_PER_USER_AUTH, SNIPEIT_STORE_PATH,
 * SNIPEIT_ENCRYPTION_KEY, SNIPEIT_PUBLIC_BASE_URL,
 * SNIPEIT_TRUST_FORWARDED_USER: the gateway has no connect, status or
 * disconnect tools), and not SNIPEIT_AUDIT_LOG.
 *
 * The address must be https and a public host name (normalizeSnipeItBaseUrl).
 * Every connection goes only to public addresses: the host name is resolved
 * and each address checked before a connection is made, and redirects are
 * never followed.
 *
 * Instance policy (writes, disabled tools, audit) comes from the host when it
 * passes `policy`; without it the instance uses the default policy (no
 * writes, no disabled tools, no audit records).
 *
 * Every call runs in a call scope of its own (AsyncLocalStorage), so a call
 * made from inside another instance's call (from its audit sink or its fetch)
 * never inherits that instance's policy, sink, redactor or caller.
 */

export type { AuditSink, InstancePolicy } from './snipeit/scope.js';
export { GatewayConfigError } from './snipeit/scope.js';
export { ADDRESS_REFUSED, normalizeSnipeItBaseUrl } from './snipeit/address.js';
export { PRIVATE_ADDRESS_REFUSED } from './snipeit/client.js';
export { KEY_REFUSED } from './key-admission.js';

export type GatewayRiskLevel = 'read' | 'write' | 'destructive';
export type GatewayJsonValue =
  | string
  | number
  | boolean
  | null
  | GatewayJsonValue[]
  | { [key: string]: GatewayJsonValue };
export type GatewayJsonObject = { [key: string]: GatewayJsonValue };

export interface GatewayToolDefinition {
  name: string;
  title: string;
  description: string;
  riskLevel: GatewayRiskLevel;
  enabledByDefault: boolean;
  inputSchema: GatewayJsonObject;
}

export interface GatewayToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: GatewayJsonValue;
  isError?: boolean;
}

/** Who and which request a call belongs to; written to the audit records of the call. */
export type GatewayCallContext = CallContext;

/** Deeply read-only JSON, as found in the frozen tool catalog. */
export type GatewayReadonlyJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly GatewayReadonlyJsonValue[]
  | { readonly [key: string]: GatewayReadonlyJsonValue };

/** One Snipe-IT API request a tool may make: the method and the path template on the customer's Snipe-IT address. */
export interface GatewayUpstreamOperation {
  readonly method: 'GET' | 'POST' | 'PATCH';
  readonly path: string;
}

/** A tool catalog entry: the gateway definition plus the upstream requests the tool may make. */
export interface GatewayToolCatalogEntry {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly riskLevel: GatewayRiskLevel;
  readonly enabledByDefault: boolean;
  readonly inputSchema: { readonly [key: string]: GatewayReadonlyJsonValue };
  /** Every Snipe-IT request the tool may make. Empty for a tool that does not call Snipe-IT. */
  readonly upstream: readonly GatewayUpstreamOperation[];
  /**
   * True when the tool can read more than its name says (anything in the
   * system, chosen by the input). No Snipe-IT gateway tool is broad.
   */
  readonly broad: boolean;
}

export interface SnipeItGatewayOptions {
  /** The customer's Snipe-IT personal API key, sent as `Authorization: Bearer`. Required; never read from the environment. */
  apiToken: string;
  /**
   * The customer's Snipe-IT address, e.g. https://assets.example.com or a hosted https address. Required; never read
   * from the environment. Checked with normalizeSnipeItBaseUrl; the client adds /api/v1.
   */
  baseUrl: string;
  /**
   * The fetch to use. Without it the built-in fetch connects only to the
   * public addresses it checked. With it, the host name is still resolved and
   * checked before every request.
   */
  fetchImpl?: typeof fetch;
  /** Time limit per Snipe-IT request in milliseconds. Default 30 seconds; never read from the environment. */
  timeoutMs?: number;
  /** Resolves the host name to its addresses (default: the system resolver). For tests and custom DNS. */
  resolveHost?: ResolveHost;
  /**
   * Instance policy from the host. Without it the instance uses the default
   * policy (no writes, no disabled tools, no audit records); it never reads
   * a policy or audit variable from the environment.
   */
  policy?: InstancePolicy;
}

/** Time limit per Snipe-IT request when the host gives none. */
const DEFAULT_TIMEOUT_MS = 30_000;

const API = '/api/v1';
const get = (path: string): GatewayUpstreamOperation => ({ method: 'GET', path: `${API}${path}` });
const post = (path: string): GatewayUpstreamOperation => ({ method: 'POST', path: `${API}${path}` });
const patch = (path: string): GatewayUpstreamOperation => ({ method: 'PATCH', path: `${API}${path}` });

/** The gateway's tools, with their own titles and descriptions. */
const GATEWAY_TOOLS: ReadonlyArray<{
  name: string;
  title: string;
  description: string;
  riskLevel: GatewayRiskLevel;
  /** The first line of a successful result's text. */
  summary: string;
  upstream: readonly GatewayUpstreamOperation[];
  broad?: boolean;
}> = [
  {
    name: 'search_capabilities',
    title: 'Search Snipe-IT capabilities',
    description: 'Find the Snipe-IT tools this connection offers, with examples.',
    riskLevel: 'read',
    summary: 'Snipe-IT capabilities.',
    upstream: [],
  },
  {
    name: 'check_connection',
    title: 'Check Snipe-IT connection',
    description: 'Verify that Snipe-IT accepts the API key, and show the user it belongs to (name, user name and email).',
    riskLevel: 'read',
    summary: 'Snipe-IT connection checked.',
    upstream: [get('/users/me')],
  },
  {
    name: 'list_assets',
    title: 'List Snipe-IT assets',
    description:
      'Search and filter hardware assets: free text, status (RTD = ready to deploy, Deployed, Undeployable, Archived, Requestable), status label, model, category, manufacturer, company, location, or what they are checked out to. `due` lists assets due or overdue for audit or check-in instead. Custom fields are not returned.',
    riskLevel: 'read',
    summary: 'Snipe-IT assets.',
    upstream: [get('/hardware'), get('/hardware/audits/{state}'), get('/hardware/checkins/{state}')],
  },
  {
    name: 'get_asset',
    title: 'Get Snipe-IT asset',
    description: 'Fetch one asset by assetId, asset tag or serial number (exactly one). Custom fields are not returned.',
    riskLevel: 'read',
    summary: 'Snipe-IT asset.',
    upstream: [get('/hardware/{assetId}'), get('/hardware/bytag/{assetTag}'), get('/hardware/byserial/{serial}')],
  },
  {
    name: 'list_licenses',
    title: 'List Snipe-IT licenses',
    description:
      'List software licenses with seats, free seats and expiration date; `expired: true` lists only licenses whose expiration date has passed. Product keys are never returned.',
    riskLevel: 'read',
    summary: 'Snipe-IT licenses.',
    upstream: [get('/licenses')],
  },
  {
    name: 'get_license',
    title: 'Get Snipe-IT license',
    description:
      'Fetch one license, and with includeSeats its seats (seat ids, and the user or asset holding each). Product keys are never returned.',
    riskLevel: 'read',
    summary: 'Snipe-IT license.',
    upstream: [get('/licenses/{licenseId}'), get('/licenses/{licenseId}/seats')],
  },
  {
    name: 'list_accessories',
    title: 'List Snipe-IT accessories',
    description: 'List accessories (keyboards, mice, cables, ...) with quantities, filtered by text, category, manufacturer, company or location.',
    riskLevel: 'read',
    summary: 'Snipe-IT accessories.',
    upstream: [get('/accessories')],
  },
  {
    name: 'list_consumables',
    title: 'List Snipe-IT consumables',
    description: 'List consumables (toner, paper, ...) with quantities left, filtered by text, category, manufacturer, company or location.',
    riskLevel: 'read',
    summary: 'Snipe-IT consumables.',
    upstream: [get('/consumables')],
  },
  {
    name: 'list_components',
    title: 'List Snipe-IT components',
    description: 'List components (memory, disks, ...) with quantities left, filtered by text, category, manufacturer, company or location.',
    riskLevel: 'read',
    summary: 'Snipe-IT components.',
    upstream: [get('/components')],
  },
  {
    name: 'list_users',
    title: 'List Snipe-IT users',
    description:
      'Search users, or fetch one by userId: name, user name, email, department, location and the number of assets, licenses, accessories and consumables assigned. Nothing else of a user is returned.',
    riskLevel: 'read',
    summary: 'Snipe-IT users.',
    upstream: [get('/users'), get('/users/{userId}')],
  },
  {
    name: 'list_locations',
    title: 'List Snipe-IT locations',
    description: 'List or search locations, with their parent and the number of assets and users.',
    riskLevel: 'read',
    summary: 'Snipe-IT locations.',
    upstream: [get('/locations')],
  },
  {
    name: 'list_reference_data',
    title: 'List Snipe-IT reference data',
    description:
      'Models, categories, manufacturers, status labels, suppliers or departments (one kind per call): the valid ids for filters, new assets and changes.',
    riskLevel: 'read',
    summary: 'Snipe-IT reference data.',
    upstream: [
      get('/models'),
      get('/categories'),
      get('/manufacturers'),
      get('/statuslabels'),
      get('/suppliers'),
      get('/departments'),
    ],
  },
  {
    name: 'get_activity_report',
    title: 'Get Snipe-IT activity report',
    description:
      'Recent activity (checkouts, checkins, updates, audits), newest first, at most 100 entries per call, filtered by item, action or target: who did what, when, to which item.',
    riskLevel: 'read',
    summary: 'Snipe-IT activity.',
    upstream: [get('/reports/activity')],
  },
  {
    name: 'create_asset',
    title: 'Create Snipe-IT asset',
    description:
      'Create a hardware asset from a model and a status label (ids from list_reference_data), with an asset tag unless Snipe-IT numbers tags itself, and optionally name, serial, company, location, supplier, order number, purchase date and cost, warranty and notes.',
    riskLevel: 'write',
    summary: 'Snipe-IT asset created.',
    upstream: [post('/hardware')],
  },
  {
    name: 'update_asset',
    title: 'Update Snipe-IT asset',
    description:
      'Change an asset’s name, status label, location, default location, notes, order number, purchase date or warranty months. Only the fields given change; the asset tag, model and custom fields cannot be changed here.',
    riskLevel: 'write',
    summary: 'Snipe-IT asset updated.',
    upstream: [patch('/hardware/{assetId}')],
  },
  {
    name: 'checkout_asset',
    title: 'Check out Snipe-IT asset',
    description: 'Check an asset out to a user (default), a location or another asset, optionally with an expected return date and a note.',
    riskLevel: 'write',
    summary: 'Snipe-IT asset checked out.',
    upstream: [post('/hardware/{assetId}/checkout')],
  },
  {
    name: 'checkin_asset',
    title: 'Check in Snipe-IT asset',
    description: 'Check an asset back in, optionally setting its location and status label.',
    riskLevel: 'write',
    summary: 'Snipe-IT asset checked in.',
    upstream: [post('/hardware/{assetId}/checkin')],
  },
  {
    name: 'audit_asset',
    title: 'Audit Snipe-IT asset',
    description: 'Record a physical audit of an asset (a log entry), optionally with its location and the next audit date.',
    riskLevel: 'write',
    summary: 'Snipe-IT asset audited.',
    upstream: [post('/hardware/{assetId}/audit')],
  },
  {
    name: 'checkout_license_seat',
    title: 'Assign Snipe-IT license seat',
    description: 'Assign one seat of a license (seatId from get_license with includeSeats) to a user (default) or an asset.',
    riskLevel: 'write',
    summary: 'Snipe-IT license seat assigned.',
    upstream: [patch('/licenses/{licenseId}/seats/{seatId}')],
  },
  {
    name: 'checkin_license_seat',
    title: 'Free Snipe-IT license seat',
    description:
      'Free one seat of a license. On a license that is not reassignable, Snipe-IT does not let the freed seat be used again.',
    riskLevel: 'write',
    summary: 'Snipe-IT license seat freed.',
    upstream: [patch('/licenses/{licenseId}/seats/{seatId}')],
  },
];

type RegisteredHandler = (input: Record<string, unknown>) => Promise<unknown>;
interface RegisteredTool {
  inputSchema: z.ZodType;
  handler: RegisteredHandler;
}

/**
 * The gateway's tools as registered: the zod input schema (strict: an
 * unknown field is refused, not dropped) and the handler bound to `client`.
 */
function registeredTools(client: SnipeItClient): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  const server = {
    registerTool(name: string, config: { inputSchema?: z.ZodRawShape }, handler: RegisteredHandler): void {
      tools.set(name, { inputSchema: z.strictObject(config.inputSchema ?? {}), handler });
    },
  };
  registerSnipeItGatewayTools(server as never, client);
  return tools;
}

/**
 * JSON Schema for a gateway tool, derived from the same zod schema the call
 * is validated with. `format` is dropped: validators such as Ajv reject
 * unknown formats in strict mode, and zod checks the values when the call runs.
 */
function toJsonSchema(schema: z.ZodType): GatewayJsonObject {
  const { $schema: _ignored, ...json } = z.toJSONSchema(schema, {
    io: 'input',
    override: ctx => {
      delete (ctx.jsonSchema as Record<string, unknown>).format;
      delete (ctx.jsonSchema as Record<string, unknown>).pattern;
    },
  }) as Record<string, unknown>;
  return json as GatewayJsonObject;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) {
      deepFreeze(entry);
    }
    Object.freeze(value);
  }
  return value;
}

// Schemas only: registration binds the handlers to a client but never calls it.
const schemas = registeredTools(
  new SnipeItClient({
    apiToken: 'schema-only',
    baseUrl: 'https://schema.invalid',
    timeoutMs: 1,
    fetchImpl: () => Promise.reject(new Error('schema only')),
    embedded: { redactor: new SecretRedactor(), resolveHost: async () => [] },
  }),
);

function definition(tool: (typeof GATEWAY_TOOLS)[number]): GatewayToolDefinition {
  const registered = schemas.get(`${TOOL_PREFIX}${tool.name}`);
  if (!registered) {
    throw new Error(`Snipe-IT gateway tool is not registered: ${tool.name}`);
  }
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    riskLevel: tool.riskLevel,
    enabledByDefault: tool.riskLevel === 'read',
    inputSchema: toJsonSchema(registered.inputSchema),
  };
}

/** All gateway tools, as definitions (names without the prefix). */
export const snipeItGatewayTools: GatewayToolDefinition[] = GATEWAY_TOOLS.map(definition);

/**
 * The tool catalog: every gateway tool with its definition, the upstream
 * requests it may make and the broad mark. Generated from the same table as
 * `snipeItGatewayTools` and deeply frozen. Hosts can use it to build their own
 * permission model without creating a gateway instance.
 */
export const snipeItToolCatalog: readonly GatewayToolCatalogEntry[] = deepFreeze(
  GATEWAY_TOOLS.map(tool => ({
    ...definition(tool),
    upstream: tool.upstream.map(operation => ({ ...operation })),
    broad: tool.broad === true,
  })),
);

const GATEWAY_TOOL_NAMES: readonly string[] = GATEWAY_TOOLS.map(tool => `${TOOL_PREFIX}${tool.name}`);
const SUMMARIES: ReadonlyMap<string, string> = new Map(
  GATEWAY_TOOLS.map(tool => [`${TOOL_PREFIX}${tool.name}`, tool.summary]),
);

/** KEY_REFUSED with every run that shares a piece with any of the secrets masked, so it holds no piece of one. */
function refusedText(field: string, secrets: readonly unknown[]): string {
  return secrets.reduce<string>((text, secret) => maskedText(text, secret), `${field}: ${KEY_REFUSED}`);
}

function requiredToken(options: SnipeItGatewayOptions | undefined, given: readonly unknown[]): string {
  const apiToken: unknown = options?.apiToken;
  if (typeof apiToken !== 'string' || apiToken.trim() === '') {
    throw new GatewayConfigError(
      'createSnipeItGateway requires options.apiToken. Embedded instances do not read credentials from the environment.',
    );
  }
  // Key admission (src/key-admission.ts): printable ASCII of 16 characters or more, sharing no piece with any text of
  // ours. Checked before anything is built from it; the refusal is a fixed text that holds no piece of it.
  if (!admitsKey(apiToken.trim())) throw new GatewayConfigError(refusedText('options.apiToken', given));
  return apiToken.trim();
}

/** A caller id from the host: redacted before it is cut short, so no part of a secret survives. */
function contextValue(value: unknown, redactor: SecretRedactor): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? redactor.redact(value.trim()).slice(0, 200) : undefined;
}

/**
 * Create one gateway instance. `apiToken` and `baseUrl` are required and are
 * the only connection settings the instance uses; a missing or refused value
 * fails here, before anything is built or sent. Where the address points is
 * checked when a connection is made (first call).
 */
export function createSnipeItGateway(options: SnipeItGatewayOptions) {
  let token: string | undefined;
  let guard: SecretRedactor | undefined;
  // What the host gave, admitted or not: every error is masked against it.
  const raw = options as Partial<SnipeItGatewayOptions> | undefined;
  const secrets = typeof raw?.apiToken === 'string' ? [raw.apiToken, raw.apiToken.trim()] : [];
  try {
    // Admission first, before a redactor is built from the token.
    token = requiredToken(options, secrets);
    guard = new SecretRedactor().addSecret(token);
    // The fixed outputs of the sink check (src/fallbacks.ts) must hold no piece of the token.
    if (leaksSecret(fixedOutputs(), guard)) {
      throw new GatewayConfigError(refusedText('options', secrets));
    }
    const gateway = buildSnipeItGateway(options, token, guard);
    // The tool list leaves the gateway as it is: a token that shares a piece with it is refused.
    if (leaksSecret(gateway.tools, guard)) {
      throw new GatewayConfigError(refusedText('options', secrets));
    }
    return gateway;
  } catch (error) {
    let message = error instanceof Error ? error.message : String(error);
    if (guard && token !== undefined) {
      // Redacted, then checked whole as the very last step: a message that still holds a piece of the token becomes
      // the fixed refusal.
      message = guard.redact(message);
      if (leaksSecret(message, guard)) message = refusedText('options', secrets);
    }
    // A fresh error in final form (src/key-admission.ts, sealedError): no cause, a stack without frames, and name,
    // message and stack masked against the token. Then the sink check on the finished object.
    const final = sealedError(new GatewayConfigError(message), ...secrets);
    if (guard && token !== undefined && leaksSecret(final, guard)) {
      throw sealedError(new GatewayConfigError(refusedText('options', secrets)), ...secrets);
    }
    throw final;
  }
}

function buildSnipeItGateway(options: SnipeItGatewayOptions, apiToken: string, redactor: SecretRedactor) {
  // Only these options are read; anything else a host passes (a token store, onBehalfOf, ...) is dropped.
  const { policy: hostPolicy, baseUrl, fetchImpl, timeoutMs, resolveHost } = options;
  const address = normalizeSnipeItBaseUrl(baseUrl);
  if (fetchImpl !== undefined && typeof fetchImpl !== 'function') {
    throw new GatewayConfigError('options.fetchImpl must be a function.');
  }
  if (resolveHost !== undefined && typeof resolveHost !== 'function') {
    throw new GatewayConfigError('options.resolveHost must be a function.');
  }
  // Always a policy: the host's, or the default one. A gateway call never reads policy or audit variables.
  const policy: ResolvedInstancePolicy = resolveInstancePolicy(hostPolicy ?? {}, GATEWAY_TOOL_NAMES);
  const clientOptions: SnipeItClientOptions = {
    apiToken,
    baseUrl: address,
    timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...(fetchImpl ? { fetchImpl } : {}),
    embedded: { redactor, ...(resolveHost ? { resolveHost } : {}) },
  };
  const client = new SnipeItClient(clientOptions);
  const handlers = registeredTools(client);
  const offeredTools: ReadonlySet<string> = new Set(GATEWAY_TOOL_NAMES.filter(name => !policy.disabledTools.has(name)));

  return {
    /** Tools enabled on this instance (tools the host's policy disables are left out). */
    tools: snipeItGatewayTools.filter(tool => !policy.disabledTools.has(canonicalToolName(tool.name))),
    callTool(toolName: string, input: GatewayJsonObject = {}, context?: GatewayCallContext): Promise<GatewayToolResult> {
      // Every call in a scope of its own.
      return runInCallScope(
        {
          policy,
          redactor,
          caller: contextValue(context?.caller, redactor),
          // Our own id for the call: the host's request id is its text, and is not written to the audit.
          requestId: randomUUID(),
          offeredTools,
        },
        // A successful result is already redacted as data by normalizeResult, and its JSON text is built from that
        // data. An error result is our own text, and is redacted as a whole.
        () =>
          runCall(toolName, input).then(result => {
            const final = result.isError ? (redactDeep(result, redactor) as GatewayToolResult) : result;
            // The sink check, as the very last step: a result that holds a piece of the token anywhere, outer fields
            // and the JSON text included, is withheld whole.
            return leaksSecret(final, redactor) ? withheldResult() : final;
          }),
      );
    },
  };

  async function runCall(toolName: string, input: GatewayJsonObject): Promise<GatewayToolResult> {
    try {
      const name = typeof toolName === 'string' ? canonicalToolName(toolName) : '';
      const tool = GATEWAY_TOOL_NAMES.includes(name) ? handlers.get(name) : undefined;
      if (!tool) {
        // Neither the audit record nor the answer repeats the name: it is the caller's text, not ours.
        await writeAuditEvent({ tool: UNKNOWN_TOOL, action: 'rejected', reason: 'unsupported tool' });
        return errorResult('Unsupported Snipe-IT gateway tool.');
      }

      const parsed = tool.inputSchema.safeParse(input ?? {});
      if (!parsed.success) {
        await writeAuditEvent({ tool: name, action: 'rejected', reason: 'invalid input' });
        const short = name.slice(TOOL_PREFIX.length);
        return errorResult(redactText(`Invalid input for ${short}: ${z.prettifyError(parsed.error)}`, redactor));
      }

      const result = await tool.handler(parsed.data as Record<string, unknown>);
      return normalizeResult(result, redactor, SUMMARIES.get(name) ?? 'Snipe-IT gateway result.');
    } catch (error) {
      return errorResult(redactText(error instanceof Error ? error.message : String(error), redactor));
    }
  }
}

/** The audit's tool for a call to a tool this gateway does not have. */
const UNKNOWN_TOOL = 'unknown_tool';

/** One gateway instance, as returned by createSnipeItGateway. */
export type SnipeItGateway = ReturnType<typeof createSnipeItGateway>;

/**
 * The handler's result as the gateway returns it: its data redacted twice
 * (values, keys and numbers by their string form), and only then serialised
 * after the summary, so a secret cannot survive in an escaped form.
 */
function normalizeResult(result: unknown, redactor: SecretRedactor, summary: string): GatewayToolResult {
  const content = (result as { content?: unknown } | null)?.content;
  const text = Array.isArray(content) ? (content[0] as { text?: unknown } | undefined)?.text : undefined;
  let data: unknown = result;
  if (typeof text === 'string') {
    try {
      data = JSON.parse(text) as unknown;
    } catch {
      // Our handlers always return JSON text; anything else is not passed on.
      return errorResult('The Snipe-IT gateway tool returned something that is not JSON; nothing of it is passed on.');
    }
  }
  // Twice: the second pass, the last step, also covers what the first inserted (the depth placeholder).
  return jsonResult(summary, redactDeep(redactDeep(data, redactor), redactor));
}

/**
 * The summary, then the same (already redacted) data as compact JSON in the text block, as the MCP spec asks of a
 * tool that returns structured content: many clients read only the text. The text holds exactly
 * `structuredContent`, and the sink check in callTool covers it.
 */
function jsonResult(text: string, structuredContent: unknown): GatewayToolResult {
  const data = toGatewayJson(structuredContent);
  return {
    content: [{ type: 'text', text: `${text}\n\n${JSON.stringify(data)}` }],
    structuredContent: data,
  };
}

function errorResult(text: string): GatewayToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text }],
  };
}

function toGatewayJson(value: unknown): GatewayJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as GatewayJsonValue;
}
