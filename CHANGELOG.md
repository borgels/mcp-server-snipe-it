# Changelog

## 0.7.1 (2026-11-21)

- Licensor and copyright holder corrected to Borgels Services ApS in `LICENSE`,
  `NOTICE` and `CONTRIBUTING.md`. The license is unchanged (FSL-1.1-ALv2).

## 0.7.0 (2026-11-21)

- License changed from Apache-2.0 to the Functional Source License, Version 1.1,
  ALv2 Future License (FSL-1.1-ALv2). You may read, run, modify and use the code
  internally and contribute changes; offering it as a competing commercial
  product or service is not allowed. Each version becomes Apache-2.0 two years
  after its release. Versions released before 0.7.0 remain under Apache-2.0
  (see `NOTICE`).

## 0.6.0

- Gateway error results carry failure metadata: when Snipe-IT answered with
  an error (an HTTP error, a refused redirect, or an answer with
  `"status": "error"`, with the status it came with, usually 200), the result
  has `failure: { httpStatus, requestId? }`, so a host can count failures by
  status without reading their text. `requestId` is Snipe-IT's id from a
  response header (`REQUEST_ID_HEADERS`), kept only when it is a hex id of 8
  to 64 characters (one run of hex digits, or groups of four or more joined
  by single hyphens, as in a UUID) and does not hold the shape of a personal
  number. It is checked again after redaction, so an id that shared a piece
  with the key is dropped. Never the body, Snipe-IT's error code or message.
  The helpers are in `src/errors.ts` (`vendorRequestId`, `requestIdFrom`,
  `failureMetadata`).

## 0.5.0 (2026-11-20)

The gateway entry point (`./gateway`) in the shape of `mcp-server-template`,
for hosts that run one instance per tenant in a shared process, each on the
customer's own Snipe-IT address.

### Changes

- `createSnipeItGateway({ apiToken, baseUrl, fetchImpl?, timeoutMs?, resolveHost?, policy? })`:
  the API key and the customer's Snipe-IT address are required and never read
  from the environment; the gateway reads no `SNIPEIT_*` variable. It has no
  connect, status or disconnect tools: every call runs as the key's own user.
- `normalizeSnipeItBaseUrl(url)`: https and a public host name only (no user
  info, port, path, query or fragment, no IP address or local name). Every
  connection of a gateway goes only to public addresses, checked by DNS per
  connection (built-in fetch) or before every request (host fetch).
  Redirects are never followed.
- Narrow tools: reads `search_capabilities`, `check_connection`,
  `list_assets`, `get_asset`, `list_licenses`, `get_license`,
  `list_accessories`, `list_consumables`, `list_components`, `list_users`,
  `list_locations`, `list_reference_data`, `get_activity_report`; writes (off
  by default) `create_asset`, `update_asset`, `checkout_asset`,
  `checkin_asset`, `audit_asset`, `checkout_license_seat`,
  `checkin_license_seat`. No generic entity tools, no free-form payload, no
  delete.
- Every answer is projected onto an allowlist of fields: license product
  keys, asset custom fields, users' phone numbers, addresses and employee
  numbers, and activity IP addresses and change details are never returned.
- `snipeItToolCatalog`: deeply frozen, with `inputSchema` from the strict zod
  schema, `upstream` and `broad`.
- Key admission, host policy `{ enableWrites, disabledTools, audit }`, call
  scopes, redaction per instance, the sink check and sealed construction
  errors, as in the template. The audit records the caller as an HMAC
  pseudonym and an error as a fixed code.
- Gateway errors are our own text: `Snipe-IT API request failed with HTTP
  <status>` with our hint and `retry-after`; Snipe-IT's error bodies are never
  read, and a `{"status":"error"}` answer on HTTP 200 becomes a fixed text
  without its messages. The MCP server's own tools and error texts are
  unchanged.

### Upgrade notes

- Node 22.19 or later (the gateway uses `undici` and `ipaddr.js`).

## 0.4.0

### Upgrade notes

- The HTTP server refuses to start on a non-loopback bind (`MCP_HTTP_HOST`/`HOST` other than
  127.0.0.1/localhost/::1), or with `MCP_ALLOW_ANY_ORIGIN=true`, unless `MCP_HTTP_TOKEN` is set.
  `MCP_HTTP_ALLOW_UNAUTHENTICATED=true` is an explicit escape hatch for networks restricted by
  other means. `SNIPEIT_TRUST_FORWARDED_USER=true` still always requires the token.
- `MCP_HTTP_TOKEN` must be at least 32 printable ASCII characters (e.g. `openssl rand -hex 32`).
  The `Bearer` scheme is now matched case-insensitively.
- `PORT`, `MCP_MAX_BODY_BYTES`, `SNIPEIT_TIMEOUT_MS` and the boolean `MCP_*` flags are validated;
  invalid values stop the server at startup instead of becoming NaN. The HTTP server also
  validates `SNIPEIT_BASE_URL` at startup in shared-token mode.
- New optional variables: `MCP_HTTP_ALLOW_UNAUTHENTICATED`, `MCP_ALLOWED_HOSTS`,
  `MCP_AUTH_FAILURE_LIMIT`, `MCP_AUTH_FAILURE_WINDOW_MS`.
- `/healthz` and `/snipeit/enroll` are unchanged and remain reachable without the token.

### Changes

- HTTP: 401 responses carry `WWW-Authenticate: Bearer`; invalid JSON gets 400 (JSON-RPC parse
  error) instead of 500; oversized bodies get 413 before the body is read when `Content-Length`
  is too large (also on the enrollment form).
- HTTP: failed authentication on `/mcp` is counted per client address; after the limit further
  failures get 429 with `Retry-After`. Valid tokens are never throttled.
- HTTP: `Host` header check on `/mcp` for loopback binds; graceful shutdown on SIGTERM/SIGINT;
  one log line per rejected request (without query strings).
- Snipe-IT client: redirects are never followed, so the token is only sent to
  `SNIPEIT_BASE_URL`. Error bodies are read up to 64 KB; configured and enrolled tokens are
  redacted by value before error text is truncated; query strings are not included in error URLs.
- The server reports the package version.
- Dependencies updated within their ranges; `fast-uri` and `@hono/node-server` overrides moved to
  the patched lines declared by their dependents. Container images are published only after CI
  passes, with SBOM and provenance attestations. Text files are normalised to LF.

## 0.3.0

Makes reachable what the API already exposed. No new tools — the tool count is
deliberately unchanged, because on a shared server every extra tool makes the
model's choice worse for everyone, while a parameter makes the server stronger
for free.

- `snipeit_list_entities` gains `filters`: server-side narrowing on every one of
  the 19 entity types. The allowed keys per entity are transcribed from the
  `$request->filled('…')` guards in each Snipe-IT controller's `index()`, so
  they are what the API actually honours rather than a guess. This is what makes
  licence compliance answerable at all — `{"expires": true}` and
  `{"maintained": true}` were simply unreachable before, as was `company_id`
  scoping on anything.
  An unrecognised key is REJECTED with the valid list, and nothing is sent.
  Snipe-IT ignores unknown query parameters silently, so passing them through
  blind would return HTTP 200 with the filter not applied — an unfiltered list
  that reads as a filtered answer. Booleans are serialised as the literal
  "true"/"false" the controllers compare against.
- Custom fields are now documented where a model will actually look. Values are
  keyed by `db_column_name` (`_snipeit_mac_address_1`), never by display name,
  and the keys were always discoverable via `fieldsets include=fields` — which
  also returns `format` (the validation regex), `type`, `required`,
  `field_encrypted` and `field_values_array`. Nothing was missing but the
  instructions, so this is a description change, not a feature.
- Capability entries gain `kind: 'tool' | 'guide'`. A guide documents how to
  compose existing tools for something the API has no single endpoint for. Two
  are added:
    * custom fields, as above;
    * kits — because the Snipe-IT API has NO kit-checkout endpoint (only the web
      UI hands out a whole kit). The guide says so and gives the real path: read
      the kit's models, pick an available asset per model, check out each. That
      stops a model hunting for an endpoint that does not exist.
  Guides are asserted not to shadow a tool id and to reference only tools that
  are actually registered, so a guide cannot rot into a dead end.

## 0.2.0

Per-user authentication, so a shared multi-user endpoint no longer means a
shared identity.

- New `SNIPEIT_PER_USER_AUTH=true` mode: each user enrols their own Snipe-IT
  personal access token and acts as themselves, with their own permissions,
  correctly attributed in Snipe-IT's action log. Previously every caller acted
  as the owner of the single `SNIPEIT_API_TOKEN` — on a superuser token, that
  made every caller a superuser and made the asset history misleading.
- New tools `snipeit_connect` / `snipeit_status` / `snipeit_disconnect`, and a
  `/snipeit/enroll` browser form. The token is pasted in the browser, never
  through the conversation, via a single-use link bound to the caller and valid
  for 10 minutes. It is validated with `GET /users/me` before being stored, so a
  bad token fails at enrollment instead of as a later 401.
- Tokens encrypted at rest (AES-256-GCM), one row per gateway-verified identity;
  `SNIPEIT_ENCRYPTION_KEY` is mandatory in this mode and refuses weak values.
- No fallback to `SNIPEIT_API_TOKEN` in per-user mode — un-enrolled callers get
  `NOT_CONNECTED` rather than borrowed rights.
- Identity is taken only from the gateway's `X-MCP-User`, and only when
  `SNIPEIT_TRUST_FORWARDED_USER=true`; never from client-controlled input.
- The audit log now records the calling user. It previously recorded the tool and
  a target hash but not the actor, so on a shared token nothing anywhere named
  who made a change.
- The auth tools are exempt from `SNIPEIT_ENABLE_WRITES`, so a read-only
  instance can still be enrolled into, and are hidden from discovery when
  per-user mode is off.

## 0.1.0

Initial release.

- 13 tools against the Snipe-IT REST API v1 (verified against v8.6.x):
  assets (search/filter/due-lists, by tag/serial, history), generic entity
  access for 19 entity types incl. subresources (license seats, checkedout
  pivot rows), activity report, create/update (PATCH-only), checkout/checkin
  for assets/accessories/consumables/components/licenses, asset audit.
- Handles the Snipe-IT envelope quirk: HTTP 200 + status:"error" is thrown
  as an error, validation messages included.
- Write tools gated behind SNIPEIT_ENABLE_WRITES=true; no delete tools.
