import { Hono } from 'hono';
import { layout } from '../views/layout.js';

const app = new Hono();

app.get('/vault', (_c) => {
  return _c.html(
    layout('Vault', '<h1>Vault Browser</h1><p class="meta">Vault API not yet implemented.</p>')
  );
});

export default app;
