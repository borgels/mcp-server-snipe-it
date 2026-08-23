# Changelog

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
