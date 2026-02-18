/**
 * Token-based authentication for WebSocket connections.
 */

import type http from 'node:http';
import { timingSafeEqual } from 'node:crypto';

const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN ?? '';

/**
 * Validates that the provided token matches the configured GATEWAY_TOKEN.
 * Returns false if GATEWAY_TOKEN is not set (empty).
 */
export function validateToken(token: string): boolean {
  if (!GATEWAY_TOKEN) return false;

  const provided = Buffer.from(token);
  const expected = Buffer.from(GATEWAY_TOKEN);
  if (provided.length !== expected.length) return false;

  return timingSafeEqual(provided, expected);
}

/**
 * Extracts auth token from the WebSocket upgrade request.
 * Supported formats:
 * - Authorization: Bearer <token>
 * - X-Gateway-Token: <token>
 * - Sec-WebSocket-Protocol: auth-token,<token>
 */
export function extractToken(req: http.IncomingMessage): string | null {
  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token) return token;
  }

  const headerToken = req.headers['x-gateway-token'];
  if (typeof headerToken === 'string' && headerToken.trim()) {
    return headerToken.trim();
  }

  const protocolHeader = req.headers['sec-websocket-protocol'];
  if (typeof protocolHeader === 'string' && protocolHeader.trim()) {
    const parts = protocolHeader.split(',').map((part) => part.trim());
    if (parts.length >= 2 && parts[0] === 'auth-token' && parts[1]) {
      return parts[1];
    }
  }

  return null;
}
