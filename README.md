# mcp-server-snipe-it

MCP server for the [Snipe-IT](https://snipe-it.readme.io/reference/api-overview) asset management REST API (v1, tested against Snipe-IT v8.6.x).

## Tools

**Read (always on):** `snipeit_list_assets` (search, meta-status, model/category/location filters, audit/checkin due-lists), `snipeit_get_asset` (by id/tag/serial + licenses/history/assigned), `snipeit_list_entities` + `snipeit_get_entity` (licenses incl. seats, accessories incl. checkedout rows, consumables, components, users incl. their assets, locations, status labels, categories, manufacturers, models, companies, departments, suppliers, custom fields, fieldsets, kits, maintenances, depreciations, groups), `snipeit_get_activity_report`, `snipeit_search_capabilities`.

**Write (opt-in via `SNIPEIT_ENABLE_WRITES=true`):** `snipeit_create_asset`, `snipeit_update_asset`, `snipeit_create_entity`, `snipeit_update_entity` (all PATCH semantics — PUT is never used because it nulls omitted fields), `snipeit_checkout`, `snipeit_checkin`, `snipeit_audit_asset`.

**Deliberately absent:** delete tools (no API restore for most entities), settings/backup endpoints, LDAP sync, import processing.

## Gotchas encoded in the server

- Snipe-IT returns **HTTP 200 for business failures** — the client throws on the `status:"error"` envelope instead of trusting the status code.
- Accessory and component **checkin uses pivot-row ids**, not entity ids (fetch them via `snipeit_get_entity` with `include=checkedout` / `include=assets`).
- Consumable checkout is irreversible; license-seat checkin on a non-reassignable license burns the seat. Tool descriptions warn about both.
- Lists are `{total, rows}` with `limit`/`offset` (server caps `limit` at 500). Default API throttle is 120 req/min (HTTP 429 + Retry-After).

## Configuration

See `.env.example`. Required: `SNIPEIT_BASE_URL`, `SNIPEIT_API_TOKEN` (personal access token, tied to the creating user's permissions).

## Run

```bash
npm install
npm run dev          # stdio
npm run dev:http     # streamable HTTP on :3000/mcp (stateless)
npm test
```

Docker images: `ghcr.io/borgels/mcp-server-snipe-it` (published on push to `main`).
