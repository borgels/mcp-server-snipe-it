import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer as createMcpServer } from '../server.js';
import type { SnipeItClient } from '../snipeit/client.js';
import type { CredentialStore } from '../snipeit/store.js';
import { trustForwardedUser } from '../snipeit/policy.js';
import {
  assertAllowedOrigin,
  assertAuthorized,
  corsHeaders,
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

  return async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');

      // Enrollment form — reached DIRECTLY by the user's browser (the reverse
      // proxy routes /snipeit/* to this container, bypassing the MCP gateway),
      // so it cannot require the gateway bearer. Its security is the
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
        sendJson(res, 404, { error: 'Not found' }, req);
        return;
      }

      assertAllowedOrigin(req);

      if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders(req));
        res.end();
        return;
      }

      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'Method not allowed' }, req, { Allow: 'POST' });
        return;
      }

      assertAuthorized(req, config);
      const body = await readJsonBody(req, config.maxBodyBytes);

      // Identity is only ever taken from the gateway-set header, never from
      // anything the MCP client can choose, and only when explicitly trusted.
      const forwardedUser = trustForwardedUser() ? firstHeader(req.headers['x-mcp-user']) : undefined;

      const mcpServer = createMcpServer({ store, onBehalfOf: forwardedUser });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, body);

      res.on('close', () => {
        void transport.close();
        void mcpServer.close();
      });
    } catch (error) {
      console.error(error);
      if (!res.headersSent) {
        if (error instanceof HttpRequestError) {
          sendJson(res, error.status, { error: error.message }, req);
          return;
        }
        sendJson(
          res,
          500,
          { jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null },
          req,
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
    if (!store.peekState(state)) {
      html(res, 400, page('Link expired', EXPIRED, false));
      return;
    }
    html(res, 200, page('Connect Snipe-IT', form(state)));
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
  const user = store.peekState(state);

  if (!user) {
    html(res, 400, page('Link expired', EXPIRED, false));
    return;
  }
  if (!apiToken) {
    // Deliberately does NOT consume the state — a blank submission is a slip,
    // not an attack, and burning the link here would force a new one.
    html(res, 400, page('Connect Snipe-IT', form(state, 'Please paste your API token.')));
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
    html(res, 400, page('Connect Snipe-IT', form(state, message)));
  }
}

function form(state: string, error = ''): string {
  const err = error ? `<p class="err">${escapeHtml(error)}</p>` : '';
  return `${err}<form method="post">
    <input type="hidden" name="state" value="${escapeHtml(state)}">
    <label for="apiToken">Snipe-IT API token</label>
    <textarea id="apiToken" name="apiToken" rows="4" autocomplete="off" spellcheck="false" required
              placeholder="paste your token here"></textarea>
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
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.byteLength;
    if (total > 64 * 1024) {
      throw new HttpRequestError(413, 'Payload too large');
    }
    chunks.push(buf);
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
