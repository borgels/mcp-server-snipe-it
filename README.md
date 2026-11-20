# mcp-server-snipe-it

MCP server for the [Snipe-IT](https://snipe-it.readme.io/reference/api-overview) asset management REST API (v1, tested against Snipe-IT v8.6.x).

This is an independent, unofficial project. It is not developed, endorsed or supported by Snipe-IT.

## Tools

**Read (always on):** `snipeit_list_assets` (search, meta-status, model/category/location filters, audit/checkin due-lists), `snipeit_get_asset` (by id/tag/serial + licenses/history/assigned), `snipeit_list_entities` + `snipeit_get_entity` (licenses incl. seats, accessories incl. checkedout rows, consumables, components, users incl. their assets, locations, status labels, categories, manufacturers, models, companies, departments, suppliers, custom fields, fieldsets, kits, maintenances, depreciations, groups), `snipeit_get_activity_report`, `snipeit_search_capabilities`.

**Write (opt-in via `SNIPEIT_ENABLE_WRITES=true`):** `snipeit_create_asset`, `snipeit_update_asset`, `snipeit_create_entity`, `snipeit_update_entity` (all PATCH semantics — PUT is never used because it nulls omitted fields), `snipeit_checkout`, `snipeit_checkin`, `snipeit_audit_asset`.

**Per-user auth (opt-in via `SNIPEIT_PER_USER_AUTH=true`):** `snipeit_connect`, `snipeit_status`, `snipeit_disconnect` — see [Authentication](#authentication).

**Deliberately absent:** delete tools (no API restore for most entities), settings/backup endpoints, LDAP sync, import processing.

## Filtering

`snipeit_list_entities` takes a `filters` object that goes straight to the index
endpoint, so narrowing happens server-side instead of by paging everything:

```json
{ "entity": "licenses",     "filters": { "expires": true } }
{ "entity": "licenses",     "filters": { "company_id": 3, "maintained": true } }
{ "entity": "users",        "filters": { "department_id": 2, "activated": true } }
{ "entity": "maintenances", "filters": { "asset_id": 17, "completed": false } }
```

The allowed keys per entity are transcribed from the `$request->filled('…')`
guards in each Snipe-IT controller's `index()`, so they are what the API really
honours. **An unknown key is an error, not a no-op** — Snipe-IT ignores
parameters it does not recognise, which would otherwise hand back an unfiltered
list with a 200 and look like a filtered answer. The error names the valid keys.
`search`, `sort`, `order`, `limit` and `offset` have their own arguments and are
refused inside `filters`.

## Custom fields

Custom-field values live on the asset, keyed by **`db_column_name`** (e.g.
`_snipeit_mac_address_1`) — never by display name, which silently does nothing.
Discover the keys first:

```
snipeit_get_entity  entity=fieldsets  id=<id>  include=fields
```

Each field comes back with `db_column_name`, `format` (the server-side
validation regex), `type`, `required`, `field_encrypted`, and
`field_values_array` (the allowed values for a dropdown). Put that key in the
`payload` of `snipeit_create_asset` or the `patch` of `snipeit_update_asset`.

## Kits

Kits can be listed and inspected, but **the API has no kit-checkout endpoint** —
only the web UI hands out a whole kit in one action. Through the API: read the
kit's contents (`entity=kits include=models|licenses|accessories|consumables`),
pick an available asset per model, then call `snipeit_checkout` per item. There
is no atomicity, so check each result rather than assuming the whole kit went
out.

## Gotchas encoded in the server

- Snipe-IT returns **HTTP 200 for business failures** — the client throws on the `status:"error"` envelope instead of trusting the status code.
- Snipe-IT also **ignores query parameters it does not recognise**, so a mistyped filter is indistinguishable from no filter in the response. Hence the per-entity allowlist.
- Accessory and component **checkin uses pivot-row ids**, not entity ids (fetch them via `snipeit_get_entity` with `include=checkedout` / `include=assets`).
- Consumable checkout is irreversible; license-seat checkin on a non-reassignable license burns the seat. Tool descriptions warn about both.
- Lists are `{total, rows}` with `limit`/`offset` (server caps `limit` at 500). Default API throttle is 120 req/min (HTTP 429 + Retry-After).

## Authentication

Two modes. `SNIPEIT_BASE_URL` is required in both.

### Shared token (default)

Set `SNIPEIT_API_TOKEN` to one personal access token. Simple, and right for
stdio or a single operator — but note what it means on a shared endpoint: every
caller acts as **the token's owner**, with that account's permissions, and
Snipe-IT's own action log credits every change to them. If that token belongs to
a superuser, everyone reaching the server is a superuser, and the asset history
tells you nothing about who actually did what.

### Per-user auth

Each user enrols their **own** Snipe-IT token, so Snipe-IT applies their own
permissions and records their name in its history.

```env
SNIPEIT_PER_USER_AUTH=true
SNIPEIT_TRUST_FORWARDED_USER=true
MCP_HTTP_TOKEN=<shared secret the gateway sends as Bearer; openssl rand -hex 32>
SNIPEIT_ENCRYPTION_KEY=<min 16 chars>
SNIPEIT_STORE_PATH=/data/store.json
SNIPEIT_PUBLIC_BASE_URL=https://snipe-it.example.com
# SNIPEIT_API_TOKEN deliberately unset
```

Adds three tools: `snipeit_connect`, `snipeit_status`, `snipeit_disconnect`.
The flow:

1. The user calls `snipeit_connect` and gets a **single-use link, valid 10
   minutes**, bound to their identity.
2. They open it — the page shows **"Linking for <identity>"**, the gateway
   identity the link is bound to — tick a box confirming that identity is
   theirs, and paste a token they created in Snipe-IT under their own
   profile → **Manage API Keys**. The token goes from their browser straight to
   the server, so it never enters the conversation transcript — a Snipe-IT token
   is bearer-equivalent to the whole account and would otherwise sit in history
   forever.
3. The server calls `GET /users/me` **with that token** before storing it, so a
   wrong or revoked token is rejected on the spot and the page can confirm which
   account was linked.
4. Tokens are encrypted at rest with AES-256-GCM, one row per verified identity.

Requirements and sharp edges:

- **Identity comes only from the gateway.** `X-MCP-User` is read only when
  `SNIPEIT_TRUST_FORWARDED_USER=true`, and never from anything the MCP client
  controls. Only enable it behind a gateway that sets the header from a
  validated token *and* strips any client-supplied copy — otherwise a caller
  can name any identity and read that person's data.
- **`MCP_HTTP_TOKEN` is required with forwarded-user trust.** The HTTP server
  refuses to start when `SNIPEIT_TRUST_FORWARDED_USER=true` and
  `MCP_HTTP_TOKEN` is empty, since without a shared bearer anything that can
  reach the port could assert an identity. The bearer is compared in constant
  time.
- **No fallback.** An un-enrolled user gets `NOT_CONNECTED`, never the shared
  token, even if `SNIPEIT_API_TOKEN` happens to be set. A fallback would hand
  them borrowed rights, which is the failure this mode exists to remove.
- **`/snipeit/enroll` must be reachable by the user's browser**, bypassing the
  MCP gateway (it cannot carry the gateway bearer). Route `/snipeit/*` on
  `SNIPEIT_PUBLIC_BASE_URL` straight to the container. Its security is the
  single-use, user-bound state token.
- **Persist `SNIPEIT_STORE_PATH`** on a volume, or every user re-enrols on
  restart. Keep `SNIPEIT_ENCRYPTION_KEY` stable too — change it and every
  stored token becomes undecryptable.
- Per-user auth separates **permissions and attribution**, not companies. Unless
  Snipe-IT's Full Multiple Companies Support is on, every user still sees every
  company's items — exactly as they would in the web UI.

## Configuration

See `.env.example` for the full list. `SNIPEIT_TIMEOUT_MS` must be a plain integer; an invalid value stops the server at startup.

### HTTP transport

| Variable | Default | Meaning |
|---|---|---|
| `MCP_HTTP_HOST` / `HOST` | `127.0.0.1` | Bind address. |
| `PORT` | `3000` | Listen port. |
| `MCP_HTTP_TOKEN` | – | Bearer token required on `/mcp`. At least 32 printable ASCII characters, e.g. `openssl rand -hex 32`. Required for any non-loopback bind and with `MCP_ALLOW_ANY_ORIGIN=true`. |
| `MCP_HTTP_ALLOW_UNAUTHENTICATED` | `false` | Serve a non-loopback bind without a token (only when access is restricted by other means). |
| `MCP_ALLOWED_ORIGINS` | localhost origins | Comma-separated exact `Origin` values allowed. Requests without `Origin` (server-to-server) are allowed. |
| `MCP_ALLOW_ANY_ORIGIN` | `false` | Allow every origin (requires `MCP_HTTP_TOKEN`). |
| `MCP_ALLOWED_HOSTS` | – | Comma-separated host names accepted in the `Host` header. Without it, a loopback bind only accepts localhost names and no check is done on other binds. |
| `MCP_MAX_BODY_BYTES` | `10485760` | Maximum request body. |
| `MCP_AUTH_FAILURE_LIMIT` | `20` | Failed authentication attempts per client address and window before further failures get 429; `0` disables. Valid tokens are never throttled. |
| `MCP_AUTH_FAILURE_WINDOW_MS` | `60000` | Window for the limit above. |

`GET /healthz` answers `{"ok":true,"perUserAuth":<true|false>}` without authentication. 401 responses carry
`WWW-Authenticate: Bearer`; invalid JSON gets 400. The server shuts down gracefully on SIGTERM/SIGINT.

`/healthz` and `/snipeit/enroll` are served without the bearer token, exactly as before (the enrollment page is reached by a browser and protected by its single-use state token). The `Host` check applies to `/mcp` only. `SNIPEIT_TRUST_FORWARDED_USER=true` always requires `MCP_HTTP_TOKEN`, also with `MCP_HTTP_ALLOW_UNAUTHENTICATED=true`.

## Embedding (`./gateway`)

`mcp-server-snipe-it/gateway` lets a host application run a narrow set of
tools in-process instead of over MCP, in the same shape as
`mcp-server-template`. One process can run several gateway instances, for
example one per tenant, each on the customer's own Snipe-IT address.

```ts
import { createSnipeItGateway, normalizeSnipeItBaseUrl, snipeItToolCatalog } from 'mcp-server-snipe-it/gateway';

// Before storing an address a customer typed: throws GatewayConfigError, or returns https://<host>.
const baseUrl = normalizeSnipeItBaseUrl(input.address);

const gateway = createSnipeItGateway({
  apiToken: tenant.snipeItApiKey,
  baseUrl,
  policy: { enableWrites: true, audit: record => log(record) },
});
const result = await gateway.callTool('list_assets', { status: 'Deployed', limit: 20 }, { caller: 'user-1' });
```

The module exports:

- `createSnipeItGateway({ apiToken, baseUrl, fetchImpl?, timeoutMs?, resolveHost?, policy? })`.
  `apiToken` is a Snipe-IT personal API key (sent as `Authorization: Bearer`),
  `baseUrl` the customer's Snipe-IT address (`https://assets.example.com`; the
  client adds `/api/v1`). Both are required and never read from the
  environment. The gateway reads no `SNIPEIT_*` variable at all: not
  `SNIPEIT_API_TOKEN`, `SNIPEIT_BASE_URL`, `SNIPEIT_TIMEOUT_MS` (default 30
  seconds), `SNIPEIT_ENABLE_WRITES` (the host's policy decides), the per-user
  mode and its store (`SNIPEIT_PER_USER_AUTH`, `SNIPEIT_STORE_PATH`,
  `SNIPEIT_ENCRYPTION_KEY`, `SNIPEIT_PUBLIC_BASE_URL`,
  `SNIPEIT_TRUST_FORWARDED_USER`) or `SNIPEIT_AUDIT_LOG`. There are no
  connect, status or disconnect tools: every call runs as the user who owns
  the API key, with that user's Snipe-IT permissions. Per-person rights are
  the host's business.
- `normalizeSnipeItBaseUrl(url)`: a pure check a host can run before it
  stores an address. It returns `https://<host>` (lower case, no trailing slash
  or dot) or throws `GatewayConfigError` with a message starting
  `Snipe-IT address refused:` (`ADDRESS_REFUSED`) that never quotes the value.
  Refused: anything but `https://`, a user name or password, a port, a path, a
  query string or a fragment, an IP address, `localhost` and local or
  single-label names (`.local`, `.internal`, `.lan`, `.home.arpa`, ...).
- `gateway.tools` (the tools enabled on the instance) and
  `gateway.callTool(name, input, { caller, requestId })`. Names are accepted
  with or without the `snipeit_` prefix. Input is validated with the tool's zod
  schema before anything is sent, and unknown fields are refused. The audit
  records of a call hold `caller` only as an HMAC pseudonym (a per-process
  key) and a request id of the server's own; the host's `requestId` is not
  written. An error is recorded as a fixed code (`http_<status>`, `timeout` or
  `error`), never as its message.
- `snipeItGatewayTools`: the definitions (`name` without prefix, `title`,
  `description`, `riskLevel`, `enabledByDefault`, `inputSchema` as JSON Schema
  derived from the zod schema the call is validated with).
- `snipeItToolCatalog`: the same tools, deeply frozen, with `upstream` (method
  and path template of every Snipe-IT request the tool may make) and `broad`
  (no Snipe-IT gateway tool is broad).
- `GatewayConfigError`, `KEY_REFUSED`, `ADDRESS_REFUSED`,
  `PRIVATE_ADDRESS_REFUSED` and the types (`SnipeItGatewayOptions`,
  `SnipeItGateway`, `InstancePolicy`, `AuditSink`, `GatewayToolDefinition`,
  `GatewayToolCatalogEntry`, `GatewayUpstreamOperation`, `GatewayToolResult`,
  `GatewayCallContext` and the JSON types such as `GatewayJsonObject`).

| Tool | Risk | Default | Snipe-IT requests (on `baseUrl`) |
|---|---|---|---|
| `search_capabilities` | read | on | none |
| `check_connection` | read | on | `GET /api/v1/users/me` |
| `list_assets` | read | on | `GET /api/v1/hardware`, `GET /api/v1/hardware/audits/{state}`, `GET /api/v1/hardware/checkins/{state}` |
| `get_asset` | read | on | `GET /api/v1/hardware/{assetId}`, `GET /api/v1/hardware/bytag/{assetTag}`, `GET /api/v1/hardware/byserial/{serial}` |
| `list_licenses` | read | on | `GET /api/v1/licenses` |
| `get_license` | read | on | `GET /api/v1/licenses/{licenseId}`, `GET /api/v1/licenses/{licenseId}/seats` |
| `list_accessories` | read | on | `GET /api/v1/accessories` |
| `list_consumables` | read | on | `GET /api/v1/consumables` |
| `list_components` | read | on | `GET /api/v1/components` |
| `list_users` | read | on | `GET /api/v1/users`, `GET /api/v1/users/{userId}` |
| `list_locations` | read | on | `GET /api/v1/locations` |
| `list_reference_data` | read | on | `GET /api/v1/models`, `/categories`, `/manufacturers`, `/statuslabels`, `/suppliers`, `/departments` (one per call) |
| `get_activity_report` | read | on | `GET /api/v1/reports/activity` |
| `create_asset` | write | off | `POST /api/v1/hardware` |
| `update_asset` | write | off | `PATCH /api/v1/hardware/{assetId}` |
| `checkout_asset` | write | off | `POST /api/v1/hardware/{assetId}/checkout` |
| `checkin_asset` | write | off | `POST /api/v1/hardware/{assetId}/checkin` |
| `audit_asset` | write | off | `POST /api/v1/hardware/{assetId}/audit` |
| `checkout_license_seat` | write | off | `PATCH /api/v1/licenses/{licenseId}/seats/{seatId}` |
| `checkin_license_seat` | write | off | `PATCH /api/v1/licenses/{licenseId}/seats/{seatId}` |

The tools are narrow on purpose: there is no generic entity list, get, create
or update in the gateway, no free-form payload and no raw path, and nothing
deletes. `update_asset` changes only name, status label, location, default
location, notes, order number, purchase date and warranty months. Read tools
get a client that can only `GET`. The MCP server's own tools
(`snipeit_list_entities`, `snipeit_create_entity`, `snipeit_checkout`, ...)
are unchanged.

**What an answer holds.** Every answer is projected onto an allowlist of
fields per kind of record; a field not on the list is never passed on. A
license's product key (`product_key`, the license `serial`) is never
returned, nor are custom fields of assets (they can hold encrypted values such
as recovery keys), phone numbers, addresses, employee numbers or permissions
of users, or the IP address, user agent and change details of activity
entries. A user is returned as name, user name, email, department, location
and the counts of what is assigned.

**Address and network.** Every connection goes only to public addresses:
the host name is resolved and every address must be public unicast
(private, loopback, link-local, carrier-grade NAT, unique local, metadata
and documentation ranges, and IPv4 embedded in IPv6 are refused). With the
built-in fetch the check runs in the connection's own lookup, so the address
checked is the address used (DNS rebinding is checked per connection). With
a host `fetchImpl` the name is checked before every request. A refusal
happens at the call, not at construction, as an error result
`Refused: the Snipe-IT address points to a private or local network address.`
(`PRIVATE_ADDRESS_REFUSED`); a name that does not resolve gives
`Network error calling the Snipe-IT API (GET) (ENOTFOUND).` Redirects are
never followed.

**Instance policy.** With `policy: { enableWrites, disabledTools, audit }`
the host decides the instance's policy: write tools run only with
`enableWrites: true`; disabled tools are left out of `tools` (and out of
`search_capabilities`) and refused when called; audit records go to `audit`
(none without it). `disabledTools` must name gateway tools. A sink that
throws on a start record refuses the call. Without `policy` the instance uses
the default policy (no writes, no disabled tools, no audit records). Every
call runs in a call scope of its own (AsyncLocalStorage), so a call made from
inside another instance's call never inherits its policy, sink, redactor or
caller. There is no process-wide registry of secrets.

**Results.** A successful result is a short English summary line, a blank
line and the data as compact JSON, exactly equal to `structuredContent`. The
data is redacted twice before it is serialised: credential-shaped text
(Authorization headers, Bearer and Basic values, JSON Web Tokens, credential
assignments) and the value of credential-named fields are masked, and the
instance's API key (exact, encoded, and any piece of 6 characters or more, in
strings, keys and the string form of numbers) is replaced by `‹redacted›`. An
answer from Snipe-IT that is not JSON is refused.

**Errors.** An error result carries our own English text, never Snipe-IT's
response body or messages, a redirect's `Location` or the configured address.
An HTTP failure starts with `Snipe-IT API request failed with HTTP <status>`,
followed by our own hint (401, 403, 404, 422, 429) and the parsed
`retry-after` where there is one. Snipe-IT often answers HTTP 200 with
`{"status":"error","messages":...}`; the gateway turns that into
`Snipe-IT refused the request (it answered with status "error"). ...` without
its messages. Other errors start with `Invalid input for <tool>:`,
`Unsupported Snipe-IT gateway tool.`, `Snipe-IT API responded with a redirect
(HTTP <status>)`, `Network error calling the Snipe-IT API`, `Snipe-IT API
request timed out after`, `Snipe-IT answered with something that is not
JSON`, `Refused: the Snipe-IT address points to a private or local network
address.`, or a policy refusal (`writes are disabled. ...`, `tool is disabled
on this instance by the embedding host: <tool>`).

**Key admission and the sink check.** A gateway accepts only an API key of
printable ASCII (0x21-0x7E) of at least 16 characters that shares no piece of
6 characters with a string literal in `src/` (`src/fixed-corpus.generated.ts`,
kept up to date by a test), with the fixed fallbacks (`src/fallbacks.ts`) or
with the tool list. A refused key throws `GatewayConfigError` at construction
(`options.apiToken: A credential was refused: ...`), before anything is built
or sent; the refusal holds no piece of the key, and every error a gateway
throws has no `cause` and a `stack` of only `name: message`. As the very last
step every output (the tool list, each result, each audit record) is checked
in its final form, and one that still holds a piece of the key is replaced by
a fixed fallback. Whether Snipe-IT accepts the key is only known at the first
call (`check_connection`: HTTP 401).

**A key for the gateway.** In Snipe-IT, the user the gateway should act as
creates a personal API key under the user menu, *Manage API Keys* (their
permission group needs the *Self: Create API keys* permission). The key is a
long JSON Web Token; pass it whole. The gateway can do what
that user may do: for the read tools the user needs view rights on assets,
licenses, accessories, consumables, components, users, locations and the
reference data and reports; for the write tools also create, edit, checkout,
checkin and audit on assets and checkout on licenses. Snipe-IT records every
change as that user's.

## Security model

- In shared-token mode every caller acts as the owner of `SNIPEIT_API_TOKEN`. With per-user auth each caller acts with their own enrolled Snipe-IT token, so Snipe-IT applies that person's permissions.
- Deciding who may reach this server, and asserting who the caller is (`X-MCP-User`), belongs in an identity-aware gateway in front of it. `MCP_HTTP_TOKEN` only authenticates that gateway.
- Tool access is not data access: `SNIPEIT_ENABLE_WRITES` and the tool set limit what can be called, not what the token can read.
- The HTTP server does not terminate TLS. Run it on a private network or behind a TLS-terminating proxy; the enrollment page in particular must only be exposed over HTTPS.
- Upstream redirects are never followed, so the token is only sent to `SNIPEIT_BASE_URL`. Error bodies are read up to 64 KB, tokens are redacted before error text is truncated, and error URLs omit query strings.

## Run

```bash
npm install
npm run dev          # stdio
npm run dev:http     # streamable HTTP on :3000/mcp (stateless)
npm test
```

Docker images: `ghcr.io/borgels/mcp-server-snipe-it` (published on push to `main`).
