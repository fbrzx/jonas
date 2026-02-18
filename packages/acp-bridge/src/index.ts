import { createInterface } from 'node:readline';
import { WebSocket } from 'ws';
import { createId } from '@jonas/shared/utils';
import { GatewayTranslator } from './translator.js';
import { SessionStore } from './session.js';

const args = process.argv.slice(2);
const urlArg = args.find((a) => a.startsWith('--url='))?.split('=')[1]
  ?? args[args.indexOf('--url') + 1];
const tokenArg = args.find((a) => a.startsWith('--token='))?.split('=')[1]
  ?? args[args.indexOf('--token') + 1];

if (!urlArg || !tokenArg) {
  console.error('Usage: jonas-acp --url wss://your.domain:18789 --token <token>');
  process.exit(1);
}

const sessionStore = new SessionStore();
const sessionKey = sessionStore.getOrCreate();

const ws = new WebSocket(urlArg, {
  headers: {
    Authorization: `Bearer ${tokenArg}`,
  },
});
const translator = new GatewayTranslator(ws);

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

ws.on('open', () => {
  process.stderr.write('Connected to Jonas gateway\n');
});

ws.on('message', (data) => {
  const frame = JSON.parse(data.toString());
  const output = translator.toStdio(frame);
  if (output) {
    process.stdout.write(output + '\n');
  }
});

ws.on('close', () => {
  process.stderr.write('Disconnected from Jonas gateway\n');
  process.exit(0);
});

ws.on('error', (err) => {
  process.stderr.write(`Gateway error: ${err.message}\n`);
  process.exit(1);
});

// Read stdin lines and send as chat messages
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  const request = translator.toGateway(trimmed, sessionKey);
  ws.send(JSON.stringify(request));
});

rl.on('close', () => {
  ws.close();
});
