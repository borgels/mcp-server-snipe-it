# mcp-server-snipe-it

MCP server for the [Snipe-IT](https://snipe-it.readme.io/reference/api-overview) asset management REST API (v1, tested against Snipe-IT v8.6.x).

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
SNIPEIT_ENCRYPTION_KEY=<min 16 chars>
SNIPEIT_STORE_PATH=/data/store.json
SNIPEIT_PUBLIC_BASE_URL=https://snipe-it.example.com
# SNIPEIT_API_TOKEN deliberately unset
```

Adds three tools: `snipeit_connect`, `snipeit_status`, `snipeit_disconnect`.
The flow:

1. The user calls `snipeit_connect` and gets a **single-use link, valid 10
   minutes**, bound to their identity.
2. They open it and paste a token they created in Snipe-IT under their own
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

See `.env.example` for the full list.

## Run

```bash
npm install
npm run dev          # stdio
npm run dev:http     # streamable HTTP on :3000/mcp (stateless)
npm test
```

Docker images: `ghcr.io/borgels/mcp-server-snipe-it` (published on push to `main`).
