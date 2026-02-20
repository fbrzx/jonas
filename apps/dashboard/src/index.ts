import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { createHash, timingSafeEqual } from 'node:crypto';
import { dirname, extname, join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createLogger } from '@jonas/shared/utils';
import statusRoutes from './routes/status.js';
import memoryRoutes from './routes/memory.js';
import skillsRoutes from './routes/skills.js';
import extensionsRoutes from './routes/extensions.js';
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
const runtimeDir = dirname(fileURLToPath(import.meta.url));
const distAssetsDir = join(runtimeDir, 'assets');
const srcAssetsDir = resolve(runtimeDir, '../src/assets');

function contentTypeForAsset(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.ico':
      return 'image/x-icon';
    case '.gif':
      return 'image/gif';
    default:
      return 'application/octet-stream';
  }
}

async function readAssetFromKnownDirs(relativePath: string): Promise<Buffer | null> {
  const candidatePaths = [join(distAssetsDir, relativePath), join(srcAssetsDir, relativePath)];
  for (const candidate of candidatePaths) {
    try {
      return await readFile(candidate);
    } catch {
      // try next path
    }
  }
  return null;
}

app.get('/assets/*', async (c) => {
  const assetPath = c.req.path.replace(/^\/assets\//, '');
  if (!assetPath || assetPath.includes('..') || assetPath.includes('\\')) {
    return c.text('Asset not found', 404);
  }

  const file = await readAssetFromKnownDirs(assetPath);
  if (!file) {
    return c.text('Asset not found', 404);
  }

  return new Response(file, {
    status: 200,
    headers: {
      'Content-Type': contentTypeForAsset(assetPath),
      'Cache-Control': 'public, max-age=300',
    },
  });
});

app.get('/manifest.webmanifest', (c) => {
  const icon = process.env.DASHBOARD_ICON_URL || '/assets/avatar.png';
  const manifest = {
    name: 'Jonas Dashboard',
    short_name: 'Jonas',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#0d1117',
    theme_color: '#161b22',
    icons: [
      { src: icon, sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
      { src: icon, sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ],
  };

  return c.json(manifest, 200, {
    'Content-Type': 'application/manifest+json; charset=utf-8',
    'Cache-Control': 'public, max-age=300',
  });
});

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
  if (path === '/health' || path === '/login' || path === '/manifest.webmanifest' || path.startsWith('/oauth/') || path.startsWith('/assets/')) {
    await next();
    return;
  }

  const expectedToken = (process.env.DASHBOARD_TOKEN ?? '').trim();
  if (!expectedToken) {
    c.status(503);
    return c.text('DASHBOARD_TOKEN is not configured');
  }

  const headerToken = c.req.header('x-dashboard-token') ?? '';
  const headerTokenMatches = headerToken.length === expectedToken.length
    && timingSafeEqual(Buffer.from(headerToken), Buffer.from(expectedToken));
  if (headerTokenMatches || hasAuthCookie(c.req.header('cookie'), expectedToken)) {
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
app.route('/', extensionsRoutes);
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
