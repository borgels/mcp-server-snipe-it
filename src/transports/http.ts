import { createServer as createNodeServer } from 'node:http';
import { SnipeItClient } from '../snipeit/client.js';
import { CredentialStore } from '../snipeit/store.js';
import { perUserAuthEnabled } from '../snipeit/policy.js';
import { getHttpConfig } from './http-helpers.js';
import { createHttpApp } from './http-app.js';

const config = getHttpConfig();
const perUser = perUserAuthEnabled();

// Built once at boot: the store reads its file and the client validates
// SNIPEIT_BASE_URL, so a misconfiguration fails here rather than on someone's
// first question. Only constructed in per-user mode — CredentialStore demands
// SNIPEIT_ENCRYPTION_KEY, which a shared-token deployment has no use for.
const store = perUser ? new CredentialStore() : undefined;
const enrollClient = perUser ? new SnipeItClient() : undefined;

const httpServer = createNodeServer(createHttpApp({ config, perUser, store, enrollClient }));

httpServer.listen(config.port, config.host, () => {
  console.error(
    `Snipe-IT MCP HTTP server listening on http://${config.host}:${config.port}/mcp` +
      (perUser ? ' (+ /snipeit/enroll, per-user auth)' : ' (shared token)'),
  );
});
