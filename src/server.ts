import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SnipeItClient, type SnipeItClientOptions } from './snipeit/client.js';
import type { CredentialStore } from './snipeit/store.js';
import { registerSnipeItTools } from './tools/snipeit.js';

export interface CreateServerOptions {
  client?: SnipeItClient;
  clientOptions?: SnipeItClientOptions;
  /** Per-user token store — required when SNIPEIT_PER_USER_AUTH=true. */
  store?: CredentialStore;
  /** Gateway-verified caller (X-MCP-User), forwarded by the HTTP transport. */
  onBehalfOf?: string;
  /** Public base URL used to build enrollment links. */
  publicBaseUrl?: string;
}

export function createServer(options: CreateServerOptions = {}): McpServer {
  const server = new McpServer({
    name: 'snipe-it',
    version: '0.3.0',
  });

  // In per-user mode this client carries no usable credential of its own — it
  // is a template that tools clone per call via withToken(). SNIPEIT_API_TOKEN
  // stays unset on such a deployment.
  const client = options.client ?? new SnipeItClient(options.clientOptions);
  registerSnipeItTools(server, client, {
    store: options.store,
    onBehalfOf: options.onBehalfOf,
    publicBaseUrl: options.publicBaseUrl,
  });

  return server;
}
