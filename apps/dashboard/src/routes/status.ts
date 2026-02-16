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

interface OllamaModelList {
  baseUrl: string;
  models: Array<{ name: string; size: number; modifiedAt: string }>;
}

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${d}d ${h}h ${m}m`;
}

function renderClaudeForm(model: string): string {
  return `
    <div class="form-group">
      <label for="claude-model"><strong>Claude Model</strong></label>
      <input type="text" id="claude-model" name="claudeModel" value="${model}" placeholder="claude-sonnet-4-5-20250929">
      <small>Enter the Claude model ID (e.g., claude-sonnet-4-5-20250929)</small>
    </div>
  `;
}

function renderOllamaForm(baseUrl: string, model: string): string {
  return `
    <div class="form-group">
      <label for="ollama-base-url"><strong>Ollama Base URL</strong></label>
      <input type="text" id="ollama-base-url" name="ollamaBaseUrl" value="${baseUrl}" placeholder="http://localhost:11434">
      <small>URL of your Ollama instance</small>
    </div>

    <div class="form-group">
      <label for="ollama-model"><strong>Model Name</strong></label>
      <input type="text" id="ollama-model" name="ollamaModel" value="${model}" placeholder="qwen2.5-coder:latest">
      <small>Enter an Ollama model name (e.g., qwen2.5-coder:latest, llama2:latest)</small>
    </div>
  `;
}

function renderModelConfig(config: ModelConfig): string {
  const isOllama = config.provider === 'ollama';
  const claudeModel = config.claude?.model ?? 'claude-sonnet-4-5-20250929';
  const ollamaBaseUrl = config.ollama?.baseUrl ?? 'http://localhost:11434';
  const ollamaModel = config.ollama?.model ?? 'qwen2.5-coder:latest';

  return `
    <div class="card" style="margin-top:1.5rem">
      <h2>Model Configuration</h2>
      <form id="model-form">
        <div class="form-group">
          <label><strong>Provider</strong></label>
          <div>
            <label>
              <input type="radio" name="provider" value="claude" ${!isOllama ? 'checked' : ''}
                     hx-get="/model/form" hx-target="#provider-config" hx-include="[name='provider']">
              Claude (via OAuth)
            </label>
          </div>
          <div>
            <label>
              <input type="radio" name="provider" value="ollama" ${isOllama ? 'checked' : ''}
                     hx-get="/model/form" hx-target="#provider-config" hx-include="[name='provider']">
              Ollama (local models)
            </label>
          </div>
        </div>

        <div id="provider-config">
          ${isOllama ? renderOllamaForm(ollamaBaseUrl, ollamaModel) : renderClaudeForm(claudeModel)}
        </div>

        <div class="form-group">
          <button type="button" class="btn btn--primary" hx-put="/model/save" hx-include="#model-form" hx-swap="none">
            Save Configuration
          </button>
        </div>

        <div class="form-group">
          <p class="badge badge--yellow">⚠️ Agent restart required after changing model provider</p>
        </div>
      </form>
    </div>
  `;
}

function renderStatus(data: StatusData, modelConfig?: ModelConfig): string {
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
    </div>
    ${modelConfig ? renderModelConfig(modelConfig) : ''}`;
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

// HTMX endpoint to update form when provider changes
app.get('/model/form', async (c) => {
  const provider = c.req.query('provider') as 'claude' | 'ollama';

  try {
    const agentUrl = process.env.AGENT_API_URL ?? 'http://localhost:3001';
    const res = await fetch(`${agentUrl}/api/model/config`);
    const config = (await res.json()) as ModelConfig;

    if (provider === 'ollama') {
      const ollamaBaseUrl = config.ollama?.baseUrl ?? 'http://localhost:11434';
      const ollamaModel = config.ollama?.model ?? 'qwen2.5-coder:latest';
      return c.html(renderOllamaForm(ollamaBaseUrl, ollamaModel));
    } else {
      const claudeModel = config.claude?.model ?? 'claude-sonnet-4-5-20250929';
      return c.html(renderClaudeForm(claudeModel));
    }
  } catch {
    return c.html('<p class="badge badge--red">Failed to load config</p>');
  }
});

// Save configuration
app.put('/model/save', async (c) => {
  try {
    const body = await c.req.parseBody();
    const provider = body.provider as 'claude' | 'ollama';

    const config: ModelConfig = { provider };

    if (provider === 'claude') {
      config.claude = { model: body.claudeModel as string };
    } else {
      config.ollama = {
        baseUrl: body.ollamaBaseUrl as string,
        model: body.ollamaModel as string,
      };
    }

    const agentUrl = process.env.AGENT_API_URL ?? 'http://localhost:3001';
    const res = await fetch(`${agentUrl}/api/model/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });

    if (!res.ok) {
      const error = (await res.json()) as { error?: string };
      throw new Error(error.error ?? 'Failed to save configuration');
    }

    return c.html(`
      <div class="badge badge--green">✅ Configuration saved! Restart the agent for changes to take effect.</div>
    `, 200, {
      'HX-Trigger': 'configSaved',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to save configuration';
    return c.html(`
      <div class="badge badge--red">❌ ${msg}</div>
    `, 500);
  }
});

export default app;
