# Changelog

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
