/**
 * WebSocket gateway server.
 * Bridges WebSocket clients to the agent HTTP API.
 */

import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { createLogger, createId } from '@jonas/shared/utils';
import type { GatewayRequest } from '@jonas/shared/types';
import { extractToken, validateToken } from './auth.js';
import { parseFrame, serializeResponse, serializeEvent } from './protocol.js';
import { SessionManager } from './session-manager.js';

const log = createLogger('gateway');

const AGENT_BASE_URL =
  process.env.AGENT_BASE_URL ?? 'http://agent:3001';

export function createGatewayServer(port: number) {
  const sessions = new SessionManager();
  const httpServer = http.createServer(handleHttpRequest);
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const token = extractToken(req.url ?? '');
    if (!token || !validateToken(token)) {
      log.warn('WebSocket upgrade rejected: invalid token');
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws, req) => {
    const wsId = createId('ws');
    const sessionKey = sessions.create(wsId);
    log.info({ wsId, sessionKey }, 'Client connected');

    ws.on('message', (raw) => {
      handleMessage(ws, wsId, sessionKey, raw.toString()).catch((err) => {
        log.error({ err, wsId }, 'Unhandled error in message handler');
      });
    });

    ws.on('close', () => {
      sessions.remove(wsId);
      log.info({ wsId }, 'Client disconnected');
    });

    ws.on('error', (err) => {
      log.error({ err, wsId }, 'WebSocket error');
    });
  });

  async function handleMessage(
    ws: WebSocket,
    wsId: string,
    sessionKey: string,
    raw: string,
  ) {
    let frame: GatewayRequest;
    try {
      const parsed = parseFrame(raw);
      if (parsed.type !== 'req') {
        ws.send(
          serializeResponse('unknown', undefined, {
            code: -32600,
            message: 'Only request frames are accepted',
          }),
        );
        return;
      }
      frame = parsed;
    } catch (err) {
      ws.send(
        serializeResponse('unknown', undefined, {
          code: -32700,
          message: `Parse error: ${(err as Error).message}`,
        }),
      );
      return;
    }

    log.debug({ method: frame.method, id: frame.id, wsId }, 'Handling request');

    try {
      switch (frame.method) {
        case 'chat.send':
          await handleChatSend(ws, frame, sessionKey);
          break;
        case 'chat.abort':
          await handleChatAbort(ws, frame, sessionKey);
          break;
        case 'sessions.list':
          handleSessionsList(ws, frame, sessions);
          break;
        case 'sessions.reset':
          await handleSessionsReset(ws, frame, sessionKey);
          break;
        case 'status':
          await handleStatus(ws, frame);
          break;
        default:
          ws.send(
            serializeResponse(frame.id, undefined, {
              code: -32601,
              message: `Unknown method: ${frame.method}`,
            }),
          );
      }
    } catch (err) {
      log.error({ err, method: frame.method }, 'Handler error');
      ws.send(
        serializeResponse(frame.id, undefined, {
          code: -32000,
          message: (err as Error).message,
        }),
      );
    }
  }

  httpServer.listen(port, () => {
    log.info({ port }, 'Gateway server listening');
  });

  return { httpServer, wss, sessions };
}

/**
 * HTTP request handler for health checks.
 */
function handleHttpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
) {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'gateway' }));
    return;
  }
  res.writeHead(404);
  res.end();
}

/**
 * Forwards a chat message to the agent API and streams events back.
 */
async function handleChatSend(
  ws: WebSocket,
  frame: GatewayRequest,
  sessionKey: string,
) {
  const { message, channel } = frame.params as {
    message?: string;
    channel?: string;
  };

  const res = await fetch(`${AGENT_BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, channel, sessionKey }),
  });

  if (!res.ok) {
    const text = await res.text();
    ws.send(
      serializeResponse(frame.id, undefined, {
        code: res.status,
        message: text || res.statusText,
      }),
    );
    return;
  }

  // Stream NDJSON response back as gateway events
  if (res.body) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const event = JSON.parse(trimmed);
            ws.send(serializeEvent('chat.stream', event));
          } catch {
            // Skip malformed lines
          }
        }
      }

      // Process remaining buffer
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer.trim());
          ws.send(serializeEvent('chat.stream', event));
        } catch {
          // Skip malformed remainder
        }
      }
    } catch (err) {
      ws.send(
        serializeEvent('chat.stream', {
          kind: 'error',
          message: (err as Error).message,
        }),
      );
    }
  }

  ws.send(serializeResponse(frame.id, { status: 'complete' }));
}

/**
 * Sends an abort request to the agent API.
 */
async function handleChatAbort(
  ws: WebSocket,
  frame: GatewayRequest,
  sessionKey: string,
) {
  const res = await fetch(`${AGENT_BASE_URL}/api/chat/abort`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionKey }),
  });

  const data = await res.json();
  ws.send(serializeResponse(frame.id, data));
}

/**
 * Returns the list of active gateway sessions.
 */
function handleSessionsList(
  ws: WebSocket,
  frame: GatewayRequest,
  sessions: SessionManager,
) {
  ws.send(serializeResponse(frame.id, { sessions: sessions.list() }));
}

/**
 * Resets an agent session.
 */
async function handleSessionsReset(
  ws: WebSocket,
  frame: GatewayRequest,
  sessionKey: string,
) {
  const res = await fetch(`${AGENT_BASE_URL}/api/sessions/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionKey }),
  });

  const data = await res.json();
  ws.send(serializeResponse(frame.id, data));
}

/**
 * Fetches the agent status.
 */
async function handleStatus(ws: WebSocket, frame: GatewayRequest) {
  const res = await fetch(`${AGENT_BASE_URL}/api/status`);
  const data = await res.json();
  ws.send(serializeResponse(frame.id, data));
}
