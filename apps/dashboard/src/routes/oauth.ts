import { Hono } from 'hono';
import { layout } from '../views/layout.js';

const app = new Hono();

const AGENT_URL = () => process.env.AGENT_API_URL ?? 'http://localhost:3001';

// GET-friendly connect endpoint (clickable from chat)
app.get('/oauth/connect/:skillDirName/:secretKey', async (c) => {
  const skillDirName = c.req.param('skillDirName');
  const secretKey = c.req.param('secretKey');
  const provider = c.req.query('provider');
  const scopes = c.req.query('scopes') ?? '';

  if (!provider) {
    return c.html(
      layout('OAuth Error', '<h1>OAuth Error</h1><p class="badge badge--red">Missing provider parameter</p>'),
    );
  }

  try {
    const params = new URLSearchParams({
      provider,
      skillDirName,
      secretKey,
      scopes,
    });
    const res = await fetch(`${AGENT_URL()}/api/oauth/authorize-url?${params.toString()}`);
    const data = (await res.json()) as { authUrl?: string; error?: string };

    if (!res.ok || !data.authUrl) {
      const errorMsg = data.error ?? 'Failed to start OAuth flow';
      const isCredsMissing = errorMsg.includes('not configured with credentials');
      const hint = isCredsMissing
        ? `<p style="margin-top:0.5rem">OAuth credentials need to be configured first. <a href="/skills/${encodeURIComponent(skillDirName)}">Go to skill settings</a> to set up the ${provider} OAuth app.</p>`
        : '';
      return c.html(
        layout('OAuth Error', `<h1>OAuth Error</h1><p class="badge badge--red">${errorMsg}</p>${hint}<p style="margin-top:1rem"><a href="/skills/${encodeURIComponent(skillDirName)}">&larr; Back to skill</a></p>`),
      );
    }

    return c.redirect(data.authUrl);
  } catch {
    return c.html(
      layout('OAuth Error', '<h1>OAuth Error</h1><p class="badge badge--red">Agent unreachable</p>'),
    );
  }
});

// Start OAuth flow — redirects browser to provider
app.post('/oauth/authorize', async (c) => {
  try {
    const body = await c.req.parseBody();
    const provider = body.provider as string;
    const skillDirName = body.skillDirName as string;
    const secretKey = body.secretKey as string;
    const scopes = body.scopes as string;

    const res = await fetch(`${AGENT_URL()}/api/oauth/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider,
        skillDirName,
        secretKey,
        scopes: scopes.split(',').map((s) => s.trim()).filter(Boolean),
      }),
    });

    const data = (await res.json()) as { authUrl?: string; error?: string };
    if (!res.ok || !data.authUrl) {
      return c.html(
        layout('OAuth Error', `<h1>OAuth Error</h1><p class="badge badge--red">${data.error ?? 'Failed to start OAuth flow'}</p><p><a href="/skills/${encodeURIComponent(skillDirName)}">&larr; Back to skill</a></p>`),
      );
    }

    return c.redirect(data.authUrl);
  } catch {
    return c.html(
      layout('OAuth Error', '<h1>OAuth Error</h1><p class="badge badge--red">Agent unreachable</p>'),
    );
  }
});

// OAuth callback — receives code from provider, exchanges for tokens
app.get('/oauth/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  const error = c.req.query('error');

  if (error) {
    const errorDesc = c.req.query('error_description');
    const errorMsg = errorDesc ? `${error}: ${errorDesc}` : error;
    return c.html(
      layout('OAuth Error', `<h1>OAuth Error</h1><p class="badge badge--red">${errorMsg}</p><p><a href="/skills">&larr; Back to skills</a></p>`),
    );
  }

  if (!code || !state) {
    return c.html(
      layout('OAuth Error', '<h1>OAuth Error</h1><p class="badge badge--red">Missing code or state</p>'),
    );
  }

  try {
    const res = await fetch(`${AGENT_URL()}/api/oauth/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, state }),
    });

    const data = (await res.json()) as { success?: boolean; skillDirName?: string; error?: string };

    if (!res.ok || !data.success) {
      return c.html(
        layout('OAuth Error', `<h1>OAuth Error</h1><p class="badge badge--red">${data.error ?? 'Token exchange failed'}</p><p><a href="/skills">&larr; Back to skills</a></p>`),
      );
    }

    const skillUrl = `/skills/${encodeURIComponent(data.skillDirName!)}`;
    return c.html(
      layout('OAuth Success', `
        <h1>Connected!</h1>
        <p>OAuth tokens have been securely stored.</p>
        <p style="margin-top:1rem"><a href="${skillUrl}">&larr; Back to skill</a></p>
        <script>setTimeout(() => window.location.href = '${skillUrl}', 2000);</script>`),
    );
  } catch {
    return c.html(
      layout('OAuth Error', '<h1>OAuth Error</h1><p class="badge badge--red">Agent unreachable</p>'),
    );
  }
});

export default app;
