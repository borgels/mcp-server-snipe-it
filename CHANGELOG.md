# Changelog

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
