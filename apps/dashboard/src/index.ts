import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { createHash } from 'node:crypto';
import { createLogger } from '@jonas/shared/utils';
import statusRoutes from './routes/status.js';
import memoryRoutes from './routes/memory.js';
import skillsRoutes from './routes/skills.js';
import vaultRoutes from './routes/vault.js';
import tasksRoutes from './routes/tasks.js';
import auditRoutes from './routes/audit.js';
import chatRoutes from './routes/chat.js';
import oauthRoutes from './routes/oauth.js';
import channelsRoutes from './routes/channels.js';
import loginRoutes from './routes/login.js';

const log = createLogger('dashboard');
const app = new Hono();
const AGENT_API_URL = process.env.AGENT_API_URL ?? 'http://localhost:3001';
const AGENT_API_TOKEN = (process.env.AGENT_API_TOKEN ?? '').trim();

const agentOrigin = (() => {
  try {
    return new URL(AGENT_API_URL).origin;
  } catch {
    return null;
  }
})();

const originalFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (
  input: Parameters<typeof originalFetch>[0],
  init?: Parameters<typeof originalFetch>[1],
): Promise<Response> => {
  if (!AGENT_API_TOKEN || !agentOrigin) {
    return originalFetch(input, init);
  }

  let url: URL;
  try {
    if (typeof input === 'string') {
      if (!input.startsWith('http://') && !input.startsWith('https://')) {
        return originalFetch(input, init);
      }
      url = new URL(input);
    } else if (input instanceof URL) {
      url = input;
    } else {
      url = new URL(input.url);
    }
  } catch {
    return originalFetch(input, init);
  }

  if (url.origin !== agentOrigin) {
    return originalFetch(input, init);
  }

  const headers = new Headers(init?.headers);
  headers.set('x-agent-token', AGENT_API_TOKEN);
  return originalFetch(input, { ...init, headers });
};

function authCookieValue(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function hasAuthCookie(cookieHeader: string | undefined, expectedToken: string): boolean {
  if (!cookieHeader) return false;

  const expectedCookieValue = authCookieValue(expectedToken);
  const cookiePart = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('dashboard_token='));

  if (!cookiePart) return false;

  const value = decodeURIComponent(cookiePart.slice('dashboard_token='.length));
  return value === expectedCookieValue;
}

// Health endpoint
app.get('/health', (c) => c.json({ status: 'ok' }));

app.use('*', async (c, next) => {
  const path = c.req.path;
  if (path === '/health' || path === '/login' || path.startsWith('/oauth/')) {
    await next();
    return;
  }

  const expectedToken = (process.env.DASHBOARD_TOKEN ?? '').trim();
  if (!expectedToken) {
    c.status(503);
    return c.text('DASHBOARD_TOKEN is not configured');
  }

  const headerToken = c.req.header('x-dashboard-token') ?? '';
  if (headerToken === expectedToken || hasAuthCookie(c.req.header('cookie'), expectedToken)) {
    await next();
    return;
  }

  if (c.req.method === 'GET') {
    return c.redirect('/login');
  }

  c.status(401);
  return c.json({ error: 'Unauthorized dashboard access' });
});

// Mount routes
app.route('/', loginRoutes);
app.route('/', chatRoutes);
app.route('/', statusRoutes);
app.route('/', memoryRoutes);
app.route('/', skillsRoutes);
app.route('/', channelsRoutes);
app.route('/', vaultRoutes);
app.route('/', tasksRoutes);
app.route('/', auditRoutes);
app.route('/', oauthRoutes);

const port = Number(process.env.DASHBOARD_PORT ?? 3000);

serve({ fetch: app.fetch, port }, () => {
  log.info({ port }, 'Jonas Dashboard listening');
});
