import type { WebSocket } from 'ws';
import { createId } from '@jonas/shared/utils';
import type { GatewayRequest, GatewayResponse, GatewayEvent } from '@jonas/shared/types';

type GatewayFrame = GatewayRequest | GatewayResponse | GatewayEvent;

export class GatewayTranslator {
  constructor(private ws: WebSocket) {}

  toGateway(stdinLine: string, sessionKey: string): GatewayRequest {
    return {
      type: 'req',
      id: createId('req'),
      method: 'chat.send',
      params: {
        sessionKey,
        message: stdinLine,
      },
    };
  }

  toStdio(frame: GatewayFrame): string | null {
    if (frame.type === 'res') {
      const res = frame as GatewayResponse;
      if (res.error) {
        return `[error] ${res.error.message}`;
      }
      return null; // Ack responses don't need output
    }

    if (frame.type === 'evt') {
      const evt = frame as GatewayEvent;
      if (evt.event === 'chat.stream') {
        const payload = evt.payload;
        switch (payload.kind) {
          case 'delta':
            return payload.text;
          case 'final':
            return `\n${payload.text}`;
          case 'tool_use':
            return `[tool] ${payload.name}(${JSON.stringify(payload.input)})`;
          case 'tool_result':
            return `[result] ${JSON.stringify(payload.output).slice(0, 200)}`;
          case 'error':
            return `[error] ${payload.message}`;
        }
      }
    }

    return null;
  }
}
