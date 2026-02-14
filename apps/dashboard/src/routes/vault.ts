import { Hono } from 'hono';
import { layout } from '../views/layout.js';

const app = new Hono();

const AGENT_URL = () => process.env.AGENT_API_URL ?? 'http://localhost:3001';

interface Connection {
  skillDirName: string;
  skillName: string;
  secretKey: string;
  provider: string;
  connected: boolean;
  scopes: string[];
}

interface Provider {
  id: string;
  name: string;
  authEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string;
}

function renderConnections(connections: Connection[]): string {
  if (connections.length === 0) {
    return '<p class="meta">No OAuth connections configured. Add OAuth config to a skill to get started.</p>';
  }

  const rows = connections
    .map((conn) => {
      const skillUrl = `/skills/${encodeURIComponent(conn.skillDirName)}`;
      const connectParams = new URLSearchParams({
        provider: conn.provider,
        scopes: conn.scopes.join(','),
      });
      const connectUrl = `/oauth/connect/${encodeURIComponent(conn.skillDirName)}/${encodeURIComponent(conn.secretKey)}?${connectParams.toString()}`;

      let actionHtml: string;
      if (conn.connected) {
        actionHtml = `
          <a href="${connectUrl}" class="btn btn--sm">Reconnect</a>
          <button class="btn btn--sm btn--danger"
            hx-post="/connections/${encodeURIComponent(conn.skillDirName)}/${encodeURIComponent(conn.secretKey)}/disconnect"
            hx-target="#connections-list"
            hx-swap="innerHTML"
            hx-confirm="Disconnect ${conn.provider} from ${conn.skillName}?"
          >Disconnect</button>`;
      } else {
        actionHtml = `<a href="${connectUrl}" class="btn btn--sm">Connect</a>`;
      }

      return `
        <tr>
          <td><a href="${skillUrl}"><strong>${conn.skillName}</strong></a></td>
          <td><code>${conn.secretKey}</code></td>
          <td>${conn.provider}</td>
          <td><span class="badge ${conn.connected ? 'badge--green' : 'badge--red'}">${conn.connected ? 'connected' : 'not connected'}</span></td>
          <td>${actionHtml}</td>
        </tr>`;
    })
    .join('');

  return `
    <table>
      <thead><tr><th>Skill</th><th>Key</th><th>Provider</th><th>Status</th><th>Action</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderProviders(providers: Provider[]): string {
  const rows = providers
    .map((p) => {
      const configured = !!p.clientId && !!p.clientSecret;
      return `
        <tr>
          <td><strong>${p.name}</strong><br><span class="meta">${p.id}</span></td>
          <td><code class="meta">${p.clientId ? p.clientId.slice(0, 12) + '...' : 'none'}</code></td>
          <td>
            <span class="badge ${configured ? 'badge--green' : 'badge--red'}">${configured ? 'configured' : 'not configured'}</span>
          </td>
          <td>
            <button class="btn btn--sm"
              hx-get="/connections/providers/${encodeURIComponent(p.id)}/edit"
              hx-target="#provider-form"
              hx-swap="innerHTML"
            >Edit</button>
            <button class="btn btn--sm btn--danger"
              hx-delete="/connections/providers/${encodeURIComponent(p.id)}"
              hx-target="#provider-list"
              hx-swap="innerHTML"
              hx-confirm="Remove provider ${p.name}?"
            >Remove</button>
          </td>
        </tr>`;
    })
    .join('');

  return `
    <table>
      <thead><tr><th>Provider</th><th>Client ID</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderEditForm(provider?: Provider): string {
  const p = provider;
  const action = p ? `/connections/providers/${encodeURIComponent(p.id)}` : '/connections/providers/new';
  return `
    <div class="card" style="margin-top:1rem">
      <h2>${p ? `Edit ${p.name}` : 'Add Provider'}</h2>
      <form hx-put="${action}"
            hx-target="#provider-list" hx-swap="innerHTML"
            hx-on::after-request="document.getElementById('provider-form').innerHTML=''"
            style="display:flex;flex-direction:column;gap:0.5rem;max-width:500px">
        ${p ? '' : `
          <label class="meta">ID (lowercase, e.g. "slack")</label>
          <input type="text" name="id" required placeholder="slack">
        `}
        <label class="meta">Display Name</label>
        <input type="text" name="name" value="${p?.name ?? ''}" required placeholder="Slack">
        <label class="meta">Auth Endpoint</label>
        <input type="text" name="authEndpoint" value="${p?.authEndpoint ?? ''}" required placeholder="https://...">
        <label class="meta">Token Endpoint</label>
        <input type="text" name="tokenEndpoint" value="${p?.tokenEndpoint ?? ''}" required placeholder="https://...">
        <label class="meta">Client ID</label>
        <input type="text" name="clientId" value="${p?.clientId ?? ''}" required placeholder="your-client-id">
        <label class="meta">Client Secret${p?.clientSecret ? ' (leave blank to keep current)' : ''}</label>
        <input type="text" name="clientSecret" value="" ${p ? '' : 'required'} placeholder="${p?.clientSecret ? 'Leave blank to keep current' : 'your-client-secret'}">
        <div style="display:flex;gap:0.5rem;margin-top:0.5rem">
          <button type="submit" class="btn">Save</button>
          <button type="button" class="btn btn--sm" onclick="document.getElementById('provider-form').innerHTML=''">Cancel</button>
        </div>
      </form>
    </div>`;
}

// --- Redirect /vault → /connections ---

app.get('/vault', (c) => c.redirect('/connections', 302));

// --- Main connections page ---

app.get('/connections', async (c) => {
  try {
    const [connRes, provRes] = await Promise.all([
      fetch(`${AGENT_URL()}/api/connections`),
      fetch(`${AGENT_URL()}/api/oauth/providers`),
    ]);
    const connections = (await connRes.json()) as Connection[];
    const providers = (await provRes.json()) as Provider[];

    return c.html(
      layout('Connections', `
        <h1>Connections</h1>
        <p class="meta" style="margin-bottom:1rem">OAuth connections across all skills.</p>
        <div id="connections-list">${renderConnections(connections)}</div>

        <details style="margin-top:2rem">
          <summary style="cursor:pointer;color:#8b949e;font-size:0.85rem">Global OAuth Providers</summary>
          <div style="margin-top:0.75rem">
            <p class="meta" style="margin-bottom:0.5rem">Global provider credentials. Skills can also store their own credentials inline.</p>
            <div class="info-box">
              <strong>Redirect URI:</strong> <code>http://localhost:3000/oauth/callback</code><br>
              Register this URL in your provider's developer console.
            </div>
            <div id="provider-list">${renderProviders(providers)}</div>
            <div id="provider-form"></div>
            <button class="btn" style="margin-top:0.5rem"
              hx-get="/connections/providers/new/edit"
              hx-target="#provider-form"
              hx-swap="innerHTML"
            >Add Custom Provider</button>
          </div>
        </details>`),
    );
  } catch {
    return c.html(
      layout('Connections', '<h1>Connections</h1><p class="badge badge--red">Agent unreachable</p>'),
    );
  }
});

// --- Disconnect ---

app.post('/connections/:skill/:key/disconnect', async (c) => {
  const skill = c.req.param('skill');
  const key = c.req.param('key');
  try {
    await fetch(`${AGENT_URL()}/api/skills/${encodeURIComponent(skill)}/values/${encodeURIComponent(key)}`, {
      method: 'DELETE',
    });
    const res = await fetch(`${AGENT_URL()}/api/connections`);
    const connections = (await res.json()) as Connection[];
    return c.html(renderConnections(connections));
  } catch {
    return c.text('Agent unreachable', 502);
  }
});

// --- Provider HTMX partials (at /connections/providers/) ---

app.get('/connections/providers/new/edit', (_c) => {
  return _c.html(renderEditForm());
});

app.get('/connections/providers/:id/edit', async (c) => {
  const id = c.req.param('id');
  try {
    const res = await fetch(`${AGENT_URL()}/api/oauth/providers`);
    const providers = (await res.json()) as Provider[];
    const provider = providers.find((p) => p.id === id);
    return c.html(renderEditForm(provider));
  } catch {
    return c.text('Agent unreachable', 502);
  }
});

app.put('/connections/providers/new', async (c) => {
  try {
    const body = await c.req.parseBody();
    const id = (body.id as string).toLowerCase().replace(/[^a-z0-9-]/g, '-');
    await fetch(`${AGENT_URL()}/api/oauth/providers/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: body.name,
        authEndpoint: body.authEndpoint,
        tokenEndpoint: body.tokenEndpoint,
        clientId: body.clientId,
        clientSecret: body.clientSecret,
      }),
    });
    const res = await fetch(`${AGENT_URL()}/api/oauth/providers`);
    const providers = (await res.json()) as Provider[];
    return c.html(renderProviders(providers));
  } catch {
    return c.text('Agent unreachable', 502);
  }
});

app.put('/connections/providers/:id', async (c) => {
  const id = c.req.param('id');
  try {
    const body = await c.req.parseBody();
    const payload: Record<string, string> = {
      name: body.name as string,
      authEndpoint: body.authEndpoint as string,
      tokenEndpoint: body.tokenEndpoint as string,
      clientId: body.clientId as string,
    };
    if (body.clientSecret) payload.clientSecret = body.clientSecret as string;
    await fetch(`${AGENT_URL()}/api/oauth/providers/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const res = await fetch(`${AGENT_URL()}/api/oauth/providers`);
    const providers = (await res.json()) as Provider[];
    return c.html(renderProviders(providers));
  } catch {
    return c.text('Agent unreachable', 502);
  }
});

app.delete('/connections/providers/:id', async (c) => {
  const id = c.req.param('id');
  try {
    await fetch(`${AGENT_URL()}/api/oauth/providers/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    const res = await fetch(`${AGENT_URL()}/api/oauth/providers`);
    const providers = (await res.json()) as Provider[];
    return c.html(renderProviders(providers));
  } catch {
    return c.text('Agent unreachable', 502);
  }
});

export default app;
