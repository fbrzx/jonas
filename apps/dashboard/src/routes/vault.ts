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

function renderConnections(connections: Connection[]): string {
  if (connections.length === 0) {
    return '<p class="meta">No connections yet. Skills that need OAuth will appear here once created.</p>';
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
        actionHtml = `<a href="${skillUrl}" class="btn btn--sm">Setup</a>`;
      }

      return `
        <tr>
          <td class="connections-col--skill"><a href="${skillUrl}"><strong>${conn.skillName}</strong></a></td>
          <td class="connections-col--key"><code>${conn.secretKey}</code></td>
          <td class="connections-col--provider">${conn.provider}</td>
          <td class="connections-col--status"><span class="badge ${conn.connected ? 'badge--green' : 'badge--red'}">${conn.connected ? 'connected' : 'not connected'}</span></td>
          <td class="connections-col--action">${actionHtml}</td>
        </tr>`;
    })
    .join('');

  return `
    <style>
      .connections-table .connections-col--skill { min-width: 180px; }
      .connections-table .connections-col--key { min-width: 180px; }
      .connections-table .connections-col--provider { min-width: 110px; }
      .connections-table .connections-col--status { min-width: 120px; white-space: nowrap; }
      .connections-table .connections-col--action { min-width: 170px; white-space: nowrap; }
    </style>
    <div class="table-scroll">
      <table class="connections-table">
        <thead><tr><th>Skill</th><th>Key</th><th>Provider</th><th>Status</th><th>Action</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// --- Redirect /vault → /connections ---

app.get('/vault', (c) => c.redirect('/connections', 302));

// --- Main connections page ---

app.get('/connections', async (c) => {
  try {
    const res = await fetch(`${AGENT_URL()}/api/connections`);
    const connections = (await res.json()) as Connection[];

    return c.html(
      layout('Connections', `
        <h1>Connections</h1>
        <p class="meta" style="margin-bottom:1rem">Connections across all skills.</p>
        <div id="connections-list">${renderConnections(connections)}</div>`),
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

export default app;
