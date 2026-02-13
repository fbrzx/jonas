/**
 * JSON-RPC-style protocol helpers for the gateway WebSocket frames.
 */

import type {
  GatewayRequest,
  GatewayResponse,
  GatewayEvent,
} from '@jonas/shared/types';

export type GatewayFrame = GatewayRequest | GatewayResponse | GatewayEvent;

export type { GatewayRequest, GatewayResponse, GatewayEvent };

/**
 * Parses a raw WebSocket message into a typed GatewayFrame.
 * Throws if the data is not valid JSON or missing required fields.
 */
export function parseFrame(data: string): GatewayFrame {
  const parsed = JSON.parse(data) as Record<string, unknown>;

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Frame must be a JSON object');
  }

  const { type } = parsed;

  if (type === 'req') {
    if (typeof parsed.id !== 'string' || !parsed.id) {
      throw new Error('Request frame requires a string "id"');
    }
    if (typeof parsed.method !== 'string' || !parsed.method) {
      throw new Error('Request frame requires a string "method"');
    }
    return parsed as unknown as GatewayRequest;
  }

  if (type === 'res') {
    if (typeof parsed.id !== 'string' || !parsed.id) {
      throw new Error('Response frame requires a string "id"');
    }
    return parsed as unknown as GatewayResponse;
  }

  if (type === 'evt') {
    if (typeof parsed.event !== 'string' || !parsed.event) {
      throw new Error('Event frame requires a string "event"');
    }
    return parsed as unknown as GatewayEvent;
  }

  throw new Error(`Unknown frame type: ${String(type)}`);
}

/**
 * Serializes a response frame to a JSON string.
 */
export function serializeResponse(
  id: string,
  result?: unknown,
  error?: { code: number; message: string },
): string {
  const frame: GatewayResponse = { type: 'res', id };
  if (error) {
    frame.error = error;
  } else {
    frame.result = result ?? null;
  }
  return JSON.stringify(frame);
}

/**
 * Serializes an event frame to a JSON string.
 */
export function serializeEvent(event: string, payload: unknown): string {
  const frame: GatewayEvent = {
    type: 'evt',
    event,
    payload: payload as GatewayEvent['payload'],
  };
  return JSON.stringify(frame);
}
