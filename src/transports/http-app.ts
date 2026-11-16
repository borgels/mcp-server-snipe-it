import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer as createMcpServer } from '../server.js';
import type { SnipeItClient } from '../snipeit/client.js';
import type { CredentialStore } from '../snipeit/store.js';
import { trustForwardedUser } from '../snipeit/policy.js';
import {
  assertAllowedHost,
  assertAllowedOrigin,
  assertAuthorized,
  AuthFailureLimiter,
  corsHeaders,
  DEFAULT_AUTH_FAILURE_LIMIT,
  DEFAULT_AUTH_FAILURE_WINDOW_MS,
  type HttpConfig,
  HttpRequestError,
  readJsonBody,
  sendJson,
} from './http-helpers.js';

export interface HttpAppOptions {
  config: HttpConfig;
  /** Per-user mode: enrollment route active, callers use their own tokens. */
  perUser: boolean;
  store?: CredentialStore;
  /** Client used only to validate a pasted token at enrollment. */
  enrollClient?: SnipeItClient;
  /** Factory for the per-request MCP server (tests inject a fake client). */
  createMcpServer?: (options: Parameters<typeof createMcpServer>[0]) => McpServer;
  /** Defaults to console.error. */
  log?: (line: string) => void;
}

/**
 * The whole HTTP surface as a plain request listener, with its dependencies
 * passed in rather than read from the environment at import time. `http.ts` is
 * the thin entrypoint that builds these from env and calls listen(); keeping
 * the two apart is what makes the enrollment flow testable without binding a
 * port or reaching into process internals.
 */
export function createHttpApp(options: HttpAppOptions): RequestListener {
  const { config, perUser, store, enrollClient } = options;
  const buildMcpServer = options.createMcpServer ?? createMcpServer;
  const log = options.log ?? ((line: string) => console.error(line));
  const failureLimit = config.authFailureLimit ?? DEFAULT_AUTH_FAILURE_LIMIT;
  const limiter = failureLimit > 0
    ? new AuthFailureLimiter(failureLimit, config.authFailureWindowMs ?? DEFAULT_AUTH_FAILURE_WINDOW_MS)
    : undefined;

  return async (req, res) => {
    const remote = req.socket.remoteAddress ?? 'unknown';
    // Query strings are not logged: the enrollment state token travels there.
    const describeRequest = () => `${req.method ?? '-'} ${(req.url ?? '').split('?')[0]?.slice(0, 200)} from ${remote}`;
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');

      // Enrollment form, reached directly by the user's browser (a reverse
      // proxy routes /snipeit/* to this server, not through the MCP
      // endpoint), so it cannot require the bearer token. Its security is the
      // single-use, user-bound state token minted by snipeit_connect.
      if (url.pathname === '/snipeit/enroll') {
        if (!perUser || !store || !enrollClient) {
          html(res, 404, page('Not enabled', '<p>This server is not running in per-user mode.</p>', false));
          return;
        }
        await handleEnroll(req, res, url, store, enrollClient);
        return;
      }

      if (url.pathname === '/healthz') {
        sendJson(res, 200, { ok: true, perUserAuth: perUser }, req);
        return;
      }

      if (url.pathname !== '/mcp') {
        throw new HttpRequestError(404, 'Not found');
      }

      assertAllowedHost(req, config);
      assertAllowedOrigin(req, config);

      if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders(req, config));
        res.end();
        return;
      }

      if (req.method !== 'POST') {
        throw new HttpRequestError(405, 'Method not allowed', { headers: { Allow: 'POST, OPTIONS' } });
      }

      try {
        assertAuthorized(req, config);
      } catch (error) {
        // Only failing requests are counted and throttled; a valid token is never blocked.
        if (limiter) {
          const retryAfter = limiter.retryAfterSeconds(remote);
          if (retryAfter > 0) {
            sendJson(res, 429, { error: 'Too many failed authentication attempts' }, req, {
              'Retry-After': String(retryAfter),
            }, config);
            return;
          }
          if (limiter.recordFailure(remote)) {
            log(`[http] ${remote} reached ${failureLimit} failed authentication attempts; further failures get 429`);
          }
        }
        throw error;
      }

      const body = await readJsonBody(req, config.maxBodyBytes);

      // Identity is only ever taken from the header set by the authenticating
      // proxy, never from anything the MCP client can choose, and only when
      // explicitly trusted.
      const forwardedUser = trustForwardedUser() ? firstHeader(req.headers['x-mcp-user']) : undefined;

      const mcpServer = buildMcpServer({ store, onBehalfOf: forwardedUser });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

      res.on('close', () => {
        void transport.close();
        void mcpServer.close();
      });

      for (const [name, value] of Object.entries(corsHeaders(req, config))) {
        res.setHeader(name, value);
      }

      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      if (error instanceof HttpRequestError) {
        log(`[http] ${error.status} ${describeRequest()}: ${error.message}`);
        if (!res.headersSent && !res.destroyed) {
          const payload = error.jsonRpcCode === undefined
            ? { error: error.message }
            : { jsonrpc: '2.0', error: { code: error.jsonRpcCode, message: error.message }, id: null };
          sendJson(res, error.status, payload, req, error.headers, config);
        }
        return;
      }

      log(`[http] 500 ${describeRequest()}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      if (!res.headersSent && !res.destroyed) {
        sendJson(
          res,
          500,
          { jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null },
          req,
          {},
          config,
        );
      }
    }
  };
}

const EXPIRED = '<p>This link is invalid or has expired. Run <code>snipeit_connect</code> again in your MCP client.</p>';

async function handleEnroll(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  store: CredentialStore,
  client: SnipeItClient,
): Promise<void> {
  if (req.method === 'GET') {
    const state = url.searchParams.get('state') ?? '';
    const owner = store.peekState(state);
    if (!owner) {
      html(res, 400, page('Link expired', EXPIRED, false));
      return;
    }
    html(res, 200, page('Connect Snipe-IT', form(state, owner)));
    return;
  }

  if (req.method !== 'POST') {
    html(res, 405, page('Method not allowed', '<p>Use the form.</p>', false));
    return;
  }

  const raw = await readRawBody(req);
  const fields = new URLSearchParams(raw);
  const state = fields.get('state') ?? '';
  const apiToken = (fields.get('apiToken') ?? '').trim();
  const confirmed = fields.get('confirmIdentity') === 'yes';
  const user = store.peekState(state);

  if (!user) {
    html(res, 400, page('Link expired', EXPIRED, false));
    return;
  }
  if (!apiToken) {
    // Deliberately does NOT consume the state — a blank submission is a slip,
    // not an attack, and burning the link here would force a new one.
    html(res, 400, page('Connect Snipe-IT', form(state, user, 'Please paste your API token.')));
    return;
  }
  if (!confirmed) {
    // Like a blank token, a missing confirmation leaves the link usable. The
    // token is never stored until the person has explicitly confirmed which
    // gateway identity it will be bound to.
    html(
      res,
      400,
      page('Connect Snipe-IT', form(state, user, 'Please confirm the identity this token will be linked to.')),
    );
    return;
  }

  try {
    // Validate against Snipe-IT before storing, so a wrong or already-revoked
    // token fails here rather than as a confusing 401 on the first real question.
    const identity = await client.verifyToken(apiToken);
    store.consumeState(state);
    store.set(user, {
      apiToken,
      connectedAt: Date.now(),
      snipeUserId: identity.id,
      snipeUsername: identity.username,
    });
    const who = identity.username ?? identity.name;
    html(
      res,
      200,
      page(
        'Snipe-IT connected',
        `<p>Linked${who ? ` as <strong>${escapeHtml(who)}</strong>` : ''}. From now on this connector acts as you, ` +
          'with your own Snipe-IT permissions. You can close this tab and return to your MCP client.</p>',
      ),
    );
  } catch (error) {
    const message =
      error instanceof Error && /\b401\b/.test(error.message)
        ? 'Snipe-IT rejected that token. Check you copied it in full, and that it has not been revoked under your profile → Manage API Keys.'
        : 'Could not verify the token with Snipe-IT. Please try again.';
    html(res, 400, page('Connect Snipe-IT', form(state, user, message)));
  }
}

function form(state: string, owner: string, error = ''): string {
  const err = error ? `<p class="err">${escapeHtml(error)}</p>` : '';
  const who = escapeHtml(owner);
  return `<p class="who">Linking for <strong>${who}</strong></p>
  <p>The token you paste will be bound to this signed-in identity. If that is not you, close this page and do not continue.</p>
  ${err}<form method="post">
    <input type="hidden" name="state" value="${escapeHtml(state)}">
    <label for="apiToken">Snipe-IT API token</label>
    <textarea id="apiToken" name="apiToken" rows="4" autocomplete="off" spellcheck="false" required
              placeholder="paste your token here"></textarea>
    <label class="check"><input type="checkbox" name="confirmIdentity" value="yes" required>
      I confirm this is my Snipe-IT token and that I am <strong>${who}</strong>.</label>
    <button type="submit">Connect</button>
  </form>
  <p class="hint">Create a token in Snipe-IT under your own profile &rarr; <strong>Manage API Keys</strong> &rarr;
  Create New Token. It is shown only once. The connector will then act as you, limited to your own permissions,
  and your name &mdash; not a shared service account &mdash; appears in Snipe-IT's history.</p>`;
}

function page(title: string, body: string, ok = true): string {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
 body{font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.5}
 h1{font-size:1.3rem} label{display:block;margin:1rem 0 .35rem;font-weight:600}
 textarea{width:100%;padding:.6rem;font-size:.95rem;font-family:ui-monospace,monospace;border:1px solid #bbb;border-radius:6px;box-sizing:border-box;resize:vertical}
 button{margin-top:1rem;padding:.6rem 1.2rem;font-size:1rem;border:0;border-radius:6px;background:#111;color:#fff;cursor:pointer}
 .who{font-size:1.1rem;padding:.6rem .8rem;border:1px solid #bbb;border-radius:6px}
 label.check{font-weight:400;display:flex;gap:.5rem;align-items:flex-start}
 .err{color:#b00020;font-weight:600} .hint{color:#555;font-size:.9rem;margin-top:1.5rem}
 @media (prefers-color-scheme:dark){
   body{background:#111;color:#eee} textarea{background:#1c1c1c;color:#eee;border-color:#444}
   button{background:#eee;color:#111} .hint{color:#aaa}
 }
</style>
<h1>${ok ? '' : '&#9888; '}${escapeHtml(title)}</h1>${body}`;
}

function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

async function readRawBody(req: IncomingMessage): Promise<string> {
  const maxBytes = 64 * 1024;
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HttpRequestError(413, 'Payload too large');
  }
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.byteLength;
      if (total > maxBytes) {
        throw new HttpRequestError(413, 'Payload too large');
      }
      chunks.push(buf);
    }
  } catch (error) {
    if (error instanceof HttpRequestError) throw error;
    throw new HttpRequestError(400, 'Request body could not be read (connection aborted)');
  }
  return Buffer.concat(chunks).toString('utf8');
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}
