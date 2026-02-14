import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { createLogger } from '@jonas/shared/utils';
import statusRoutes from './routes/status.js';
import memoryRoutes from './routes/memory.js';
import skillsRoutes from './routes/skills.js';
import modelRoutes from './routes/model.js';
import vaultRoutes from './routes/vault.js';
import tasksRoutes from './routes/tasks.js';
import auditRoutes from './routes/audit.js';
import chatRoutes from './routes/chat.js';
import oauthRoutes from './routes/oauth.js';

const log = createLogger('dashboard');
const app = new Hono();

// Health endpoint
app.get('/health', (c) => c.json({ status: 'ok' }));

// Mount routes
app.route('/', chatRoutes);
app.route('/', statusRoutes);
app.route('/', memoryRoutes);
app.route('/', skillsRoutes);
app.route('/model', modelRoutes);
app.route('/', vaultRoutes);
app.route('/', tasksRoutes);
app.route('/', auditRoutes);
app.route('/', oauthRoutes);

const port = Number(process.env.DASHBOARD_PORT ?? 3000);

serve({ fetch: app.fetch, port }, () => {
  log.info({ port }, 'Jonas Dashboard listening');
});
