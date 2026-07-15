import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SnipeItClient, type SnipeItClientOptions } from './snipeit/client.js';
import { registerSnipeItTools } from './tools/snipeit.js';

export interface CreateServerOptions {
  client?: SnipeItClient;
  clientOptions?: SnipeItClientOptions;
}

export function createServer(options: CreateServerOptions = {}): McpServer {
  const server = new McpServer({
    name: 'snipe-it',
    version: '0.1.0',
  });

  const client = options.client ?? new SnipeItClient(options.clientOptions);
  registerSnipeItTools(server, client);

  return server;
}
