/**
 * Gateway service entry point.
 * Starts the WebSocket gateway that bridges clients to the agent API.
 */

import { createLogger } from '@jonas/shared/utils';
import { createGatewayServer } from './server.js';

const log = createLogger('gateway');

const GATEWAY_PORT = parseInt(process.env.GATEWAY_PORT ?? '18789', 10);
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN;

if (!GATEWAY_TOKEN) {
  log.warn('GATEWAY_TOKEN is not set -- all connections will be rejected');
}

log.info({ port: GATEWAY_PORT }, 'Starting gateway server');

const { httpServer } = createGatewayServer(GATEWAY_PORT);

// Graceful shutdown
function shutdown(signal: string) {
  log.info({ signal }, 'Shutting down gateway');
  httpServer.close(() => {
    log.info('Gateway server closed');
    process.exit(0);
  });
  // Force exit after timeout
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('uncaughtException', (err) => {
  log.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  log.fatal({ err }, 'Unhandled rejection');
  process.exit(1);
});
