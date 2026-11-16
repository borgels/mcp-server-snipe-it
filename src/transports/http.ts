import { ConfigError } from '../config-env.js';
import { SnipeItClient } from '../snipeit/client.js';
import { CredentialStore } from '../snipeit/store.js';
import { perUserAuthEnabled } from '../snipeit/policy.js';
import { configWarnings, getHttpConfig, type HttpConfig } from './http-helpers.js';
import { createHttpApp } from './http-app.js';
import { startHttpServer } from './http-server.js';

async function main(): Promise<void> {
  let config: HttpConfig;
  try {
    // Also refuses SNIPEIT_TRUST_FORWARDED_USER=true without MCP_HTTP_TOKEN.
    config = getHttpConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`Snipe-IT MCP HTTP server not started: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  const perUser = perUserAuthEnabled();
  let store: CredentialStore | undefined;
  let enrollClient: SnipeItClient | undefined;
  try {
    // Built once at boot: the client validates SNIPEIT_BASE_URL and
    // SNIPEIT_TIMEOUT_MS, and the store reads its file, so a misconfiguration
    // fails here rather than on someone's first question. The store is only
    // constructed in per-user mode: CredentialStore demands
    // SNIPEIT_ENCRYPTION_KEY, which a shared-token deployment has no use for.
    const client = new SnipeItClient();
    store = perUser ? new CredentialStore() : undefined;
    enrollClient = perUser ? client : undefined;
  } catch (error) {
    console.error(`Snipe-IT MCP HTTP server not started: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  for (const warning of configWarnings(config)) {
    console.error(warning);
  }

  const running = await startHttpServer(config, createHttpApp({ config, perUser, store, enrollClient }));
  console.error(
    `Snipe-IT MCP HTTP server listening on http://${config.host}:${running.port}/mcp` +
      (perUser ? ' (+ /snipeit/enroll, per-user auth)' : ' (shared token)'),
  );

  const shutdown = (signal: string) => {
    console.error(`Received ${signal}, shutting down`);
    void running.close().then(() => process.exit(0));
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
