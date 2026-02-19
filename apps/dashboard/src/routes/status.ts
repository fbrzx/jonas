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

interface ModelConfig {
  provider: 'claude' | 'ollama';
  claude?: { model: string };
  ollama?: { baseUrl: string; model: string };
}

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${d}d ${h}h ${m}m`;
}

function renderModelConfig(config: ModelConfig): string {
  const provider = config.provider === 'ollama' ? 'Ollama (local models)' : 'Claude (via OAuth)';
  const modelName = config.provider === 'ollama'
    ? (config.ollama?.model ?? 'not configured')
    : (config.claude?.model ?? 'not configured');
  const baseUrlRow = config.provider === 'ollama'
    ? `<tr>
            <th>Ollama Base URL</th>
            <td><code>${config.ollama?.baseUrl ?? 'not configured'}</code></td>
          </tr>`
    : '';

  return `
    <div class="card" style="margin-bottom:1.5rem">
      <h2>Model Configuration</h2>
      <div class="table-scroll">
        <table style="min-width:520px">
          <tbody>
            <tr>
              <th>Provider</th>
              <td>${provider}</td>
            </tr>
            <tr>
              <th>Model</th>
              <td><code>${modelName}</code></td>
            </tr>
            ${baseUrlRow}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderStatus(data: StatusData, modelConfig?: ModelConfig): string {
  return `
    ${modelConfig ? renderModelConfig(modelConfig) : ''}

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:1rem;margin-bottom:1rem">
      <div class="card">
        <h2>Uptime</h2>
        <p>${formatUptime(data.uptime)}</p>
      </div>
      <div class="card">
        <h2>Active Conversations</h2>
        <p>${data.activeConversations}</p>
      </div>
      
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:1rem">
      <div class="card">
        <h2>Gateway</h2>
        <span class="badge ${data.channels.gateway ? 'badge--green' : 'badge--red'}">${data.channels.gateway ? 'connected' : 'offline'}</span>
      </div>
      <div class="card">
        <h2>Dashboard</h2>
        <span class="badge ${data.channels.dashboard ? 'badge--green' : 'badge--red'}">${data.channels.dashboard ? 'connected' : 'offline'}</span>
      </div>
      <div class="card">
        <h2>Memory</h2>
        <p>Episodic: ${data.memoryStats.episodic}</p>
        <p>Semantic: ${data.memoryStats.semantic}</p>
        <p>Procedural: ${data.memoryStats.procedural}</p>
        <p><span class="badge badge--green">healthy</span></p>
      </div>
    </div>
  `;
}

function renderError(message: string): string {
  return `<div class="card"><p class="badge badge--red">${message}</p></div>`;
}

app.get('/', async (c) => {
  const isHtmx = c.req.header('HX-Request') === 'true';

  try {
    const agentUrl = process.env.AGENT_API_URL ?? 'http://localhost:3001';
    const [statusRes, modelRes] = await Promise.all([
      fetch(`${agentUrl}/api/status`),
      fetch(`${agentUrl}/api/model/config`)
    ]);

    const data = (await statusRes.json()) as StatusData;
    const modelConfig = modelRes.ok ? (await modelRes.json()) as ModelConfig : undefined;
    const content = renderStatus(data, modelConfig);

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
