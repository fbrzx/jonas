/**
 * MCP Gateway Bridge
 *
 * Connects to Jonas Gateway via WebSocket and exposes an MCP server via stdio
 * for Claude Desktop integration.
 *
 * Usage in Claude Desktop config (~/.config/Claude/claude_desktop_config.json):
 * {
 *   "mcpServers": {
 *     "jonas": {
 *       "command": "jonas-mcp",
 *       "args": ["--url", "ws://localhost:18789", "--token", "YOUR_TOKEN"],
 *       "env": {}
 *     }
 *   }
 * }
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { WebSocket } from 'ws';
import { createId } from '@jonas/shared/utils';
import type { GatewayRequest, GatewayResponse, GatewayEvent } from '@jonas/shared/types';

// Parse command line args
const args = process.argv.slice(2);
const urlArg = args.find((a) => a.startsWith('--url='))?.split('=')[1]
  ?? args[args.indexOf('--url') + 1];
const tokenArg = args.find((a) => a.startsWith('--token='))?.split('=')[1]
  ?? args[args.indexOf('--token') + 1];

if (!urlArg || !tokenArg) {
  console.error('Usage: jonas-mcp --url <gateway-url> --token <gateway-token>');
  console.error('Example: jonas-mcp --url ws://localhost:18789 --token abc123');
  process.exit(1);
}

const GATEWAY_URL = urlArg;

// WebSocket connection state
let ws: WebSocket | null = null;
let sessionKey: string | null = null;
const pendingRequests = new Map<string, {
  resolve: (value: string) => void;
  reject: (error: Error) => void;
  buffer: string[];
}>();

function connectGateway(): Promise<void> {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(GATEWAY_URL, {
      headers: {
        Authorization: `Bearer ${tokenArg}`,
      },
    });
    sessionKey = createId('sess');

    ws.on('open', () => {
      console.error('[MCP Bridge] Connected to Jonas gateway');
      resolve();
    });

    ws.on('message', (data) => {
      try {
        const frame = JSON.parse(data.toString()) as GatewayResponse | GatewayEvent;

        if (frame.type === 'res') {
          // Response to our request
          const pending = pendingRequests.get(frame.id);
          if (pending) {
            if (frame.error) {
              pending.reject(new Error(frame.error.message));
            } else {
              // Response complete, resolve with buffered content
              pending.resolve(pending.buffer.join(''));
            }
            pendingRequests.delete(frame.id);
          }
        } else if (frame.type === 'evt') {
          // Streaming event
          if (frame.event === 'chat.stream') {
            const payload = frame.payload;
            // Find the request ID from the first pending request
            // (assumes one request at a time for simplicity)
            const [requestId, pending] = Array.from(pendingRequests.entries())[0] || [];
            if (pending) {
              if (payload.kind === 'delta' || payload.kind === 'final') {
                pending.buffer.push(payload.text);
              } else if (payload.kind === 'error') {
                pending.reject(new Error(payload.message));
                pendingRequests.delete(requestId!);
              }
            }
          }
        }
      } catch (err) {
        console.error('[MCP Bridge] Error parsing gateway message:', err);
      }
    });

    ws.on('close', () => {
      console.error('[MCP Bridge] Disconnected from Jonas gateway');
      // Reject all pending requests
      for (const [id, pending] of pendingRequests.entries()) {
        pending.reject(new Error('Gateway connection closed'));
        pendingRequests.delete(id);
      }
    });

    ws.on('error', (err) => {
      console.error('[MCP Bridge] Gateway connection error:', err);
      reject(err);
    });
  });
}

async function sendChatMessage(message: string): Promise<string> {
  if (!ws || !sessionKey) {
    throw new Error('Not connected to gateway');
  }

  const requestId = createId('req');
  const request: GatewayRequest = {
    type: 'req',
    id: requestId,
    method: 'chat.send',
    params: {
      message,
      sessionKey,
    },
  };

  return new Promise((resolve, reject) => {
    pendingRequests.set(requestId, { resolve, reject, buffer: [] });
    ws!.send(JSON.stringify(request));
  });
}

// Initialize MCP server
const server = new McpServer({
  name: 'jonas-gateway-bridge',
  version: '0.1.0',
});

// Expose a single "chat" tool that sends messages to Jonas
server.tool(
  'jonas_chat',
  'Send a message to Jonas and get a response. Jonas has access to memory, vault, skills, tasks, and all configured tools.',
  {
    message: z.string().describe('The message to send to Jonas'),
  },
  async ({ message }) => {
    try {
      const response = await sendChatMessage(message);
      return {
        content: [{
          type: 'text',
          text: response,
        }],
      };
    } catch (err) {
      return {
        content: [{
          type: 'text',
          text: `Error: ${(err as Error).message}`,
        }],
        isError: true,
      };
    }
  },
);

// Add session management tools
server.tool(
  'jonas_reset_session',
  'Reset the conversation session with Jonas (clears context)',
  {},
  async () => {
    sessionKey = createId('sess');
    return {
      content: [{
        type: 'text',
        text: 'Session reset. Jonas will start a new conversation context.',
      }],
    };
  },
);

server.tool(
  'jonas_status',
  'Check Jonas agent status and availability',
  {},
  async () => {
    if (!ws || !sessionKey) {
      return {
        content: [{
          type: 'text',
          text: 'Not connected to Jonas gateway',
        }],
        isError: true,
      };
    }

    const requestId = createId('req');
    const request: GatewayRequest = {
      type: 'req',
      id: requestId,
      method: 'status',
      params: {},
    };

    return new Promise((resolve, reject) => {
      pendingRequests.set(requestId, {
        resolve: (value) => {
          resolve({
            content: [{
              type: 'text',
              text: value,
            }],
          });
        },
        reject,
        buffer: [],
      });
      ws!.send(JSON.stringify(request));
    });
  },
);

// Start everything
async function main() {
  try {
    await connectGateway();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('[MCP Bridge] MCP server ready');
  } catch (err) {
    console.error('[MCP Bridge] Failed to start:', err);
    process.exit(1);
  }
}

main();
