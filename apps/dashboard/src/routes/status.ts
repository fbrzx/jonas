import { Hono } from 'hono';
import { layout } from '../views/layout.js';

const app = new Hono();

interface StatusData {
  uptime: number;
  model: string;
  memoryStats: { episodic: number; semantic: number; procedural: number };
  activeConversations: number;
  channels: { dashboard: boolean; gateway: boolean };
}

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${d}d ${h}h ${m}m`;
}

function renderStatus(data: StatusData): string {
  return `
    <div class="grid">
      <div class="card">
        <h2>Uptime</h2>
        <p>${formatUptime(data.uptime)}</p>
      </div>
      <div class="card">
        <h2>Model</h2>
        <p>${data.model}</p>
      </div>
      <div class="card">
        <h2>Active Conversations</h2>
        <p>${data.activeConversations}</p>
      </div>
      <div class="card">
        <h2>Memory</h2>
        <p>Episodic: ${data.memoryStats.episodic}</p>
        <p>Semantic: ${data.memoryStats.semantic}</p>
        <p>Procedural: ${data.memoryStats.procedural}</p>
      </div>
    </div>
    <div class="card">
      <h2>Channels</h2>
      <table>
        <thead><tr><th>Channel</th><th>Status</th></tr></thead>
        <tbody>
          <tr>
            <td>Dashboard</td>
            <td><span class="badge ${data.channels.dashboard ? 'badge--green' : 'badge--red'}">${data.channels.dashboard ? 'connected' : 'offline'}</span></td>
          </tr>
          <tr>
            <td>Gateway</td>
            <td><span class="badge ${data.channels.gateway ? 'badge--green' : 'badge--red'}">${data.channels.gateway ? 'connected' : 'offline'}</span></td>
          </tr>
        </tbody>
      </table>
    </div>`;
}

function renderError(message: string): string {
  return `<div class="card"><p class="badge badge--red">${message}</p></div>`;
}

app.get('/', async (c) => {
  const isHtmx = c.req.header('HX-Request') === 'true';

  try {
    const agentUrl = process.env.AGENT_API_URL ?? 'http://localhost:3001';
    const res = await fetch(`${agentUrl}/api/status`);
    const data = (await res.json()) as StatusData;
    const content = renderStatus(data);

    if (isHtmx) return c.html(content);

    const wrapped = `
      <h1>Agent Status</h1>
      <div id="status-content" hx-get="/" hx-trigger="every 5s" hx-swap="innerHTML">
        ${content}
      </div>`;
    return c.html(layout('Status', wrapped));
  } catch {
    const content = renderError('Agent unreachable');
    if (isHtmx) return c.html(content);
    return c.html(
      layout(
        'Status',
        `<h1>Agent Status</h1>
        <div id="status-content" hx-get="/" hx-trigger="every 5s" hx-swap="innerHTML">
          ${content}
        </div>`
      )
    );
  }
});

export default app;
