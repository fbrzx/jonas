import { Hono } from 'hono';
import { createHash } from 'node:crypto';

const app = new Hono();

function authCookieValue(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function renderLoginPage(error = ''): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Jonas Dashboard Login</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #0d1117; color: #c9d1d9; margin: 0; }
    .wrap { max-width: 420px; margin: 10vh auto; padding: 1.25rem; background: #161b22; border: 1px solid #30363d; border-radius: 8px; }
    h1 { margin: 0 0 1rem; font-size: 1.1rem; color: #f0f6fc; }
    label { display:block; font-size: 0.85rem; margin-bottom: 0.4rem; }
    input { width: 100%; box-sizing: border-box; background: #0d1117; color: #c9d1d9; border: 1px solid #30363d; border-radius: 6px; padding: 0.55rem 0.7rem; }
    button { margin-top: 0.8rem; background: #238636; color: #fff; border: none; border-radius: 6px; padding: 0.5rem 0.8rem; cursor: pointer; }
    .err { margin-top: 0.7rem; color: #f85149; font-size: 0.85rem; }
  </style>
</head>
<body>
  <main class="wrap">
    <h1>Dashboard Access</h1>
    <form method="post" action="/login">
      <label for="token">DASHBOARD TOKEN</label>
      <input id="token" name="token" type="password" autocomplete="current-password" required />
      <button type="submit">Sign in</button>
    </form>
    ${error ? `<div class="err">${error}</div>` : ''}
  </main>
</body>
</html>`;
}

app.get('/login', (c) => c.html(renderLoginPage()));

app.post('/login', async (c) => {
  const expected = (process.env.DASHBOARD_TOKEN ?? '').trim();
  if (!expected) {
    return c.text('DASHBOARD_TOKEN is not configured', 503);
  }

  const body = await c.req.parseBody();
  const token = String(body.token ?? '');
  if (token !== expected) {
    return c.html(renderLoginPage('Invalid dashboard token.'));
  }

  const cookieValue = encodeURIComponent(authCookieValue(expected));
  c.header(
    'Set-Cookie',
    `dashboard_token=${cookieValue}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800`
  );
  return c.redirect('/');
});

app.post('/logout', (c) => {
  c.header('Set-Cookie', 'dashboard_token=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  return c.redirect('/login');
});

export default app;
