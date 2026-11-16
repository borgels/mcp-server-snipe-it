import { createServer as createNodeServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { assertSecureConfig, assertSafeHttpStartup, type HttpConfig } from './http-helpers.js';

export interface StartOptions {
  /** Time in-flight requests get on close() before connections are destroyed. */
  shutdownGraceMs?: number;
}

export interface RunningHttpServer {
  server: Server;
  port: number;
  close(): Promise<void>;
}

const DEFAULT_SHUTDOWN_GRACE_MS = 5_000;

/**
 * Starts the HTTP transport with the given request listener. `config.port` 0
 * picks an ephemeral port. Throws
 * ConfigError for configurations refused by assertSecureConfig.
 */
export async function startHttpServer(
  config: HttpConfig,
  listener: RequestListener,
  options: StartOptions = {},
): Promise<RunningHttpServer> {
  assertSecureConfig(config);
  assertSafeHttpStartup(process.env, config.httpToken);
  const server = createNodeServer(listener);
  const graceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const port = (server.address() as AddressInfo).port;
  let closing: Promise<void> | undefined;

  // While shutting down, let in-flight requests finish and then drop their
  // keep-alive sockets instead of waiting for the force-close timer.
  server.on('request', (_req, res) => {
    res.on('finish', () => {
      if (closing) {
        server.closeIdleConnections();
      }
    });
  });

  return {
    server,
    port,
    close() {
      closing ??= new Promise<void>(resolve => {
        server.on('request', (_req, res) => res.setHeader('Connection', 'close'));
        const force = setTimeout(() => server.closeAllConnections(), graceMs);
        force.unref();
        server.close(() => {
          clearTimeout(force);
          resolve();
        });
        server.closeIdleConnections();
      });
      return closing;
    },
  };
}
