export type GatewayMethod =
  | 'chat.send'
  | 'chat.abort'
  | 'sessions.list'
  | 'sessions.reset'
  | 'status';

export interface GatewayRequest {
  type: 'req';
  id: string;
  method: GatewayMethod;
  params: Record<string, unknown>;
}

export interface GatewayResponse {
  type: 'res';
  id: string;
  result?: unknown;
  error?: { code: number; message: string };
}

export type ChatEventPayload =
  | { kind: 'delta'; text: string }
  | { kind: 'tool_use'; name: string; input: Record<string, unknown> }
  | { kind: 'tool_result'; name: string; output: unknown }
  | { kind: 'final'; text: string }
  | { kind: 'error'; message: string };

export interface GatewayEvent {
  type: 'evt';
  event: string;
  payload: ChatEventPayload;
}
