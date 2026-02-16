import { Hono } from 'hono';
import { layout } from '../views/layout.js';

const app = new Hono();

interface ModelConfig {
  provider: 'claude' | 'ollama';
  claude?: { model: string };
  ollama?: { baseUrl: string; model: string };
}

interface OllamaModelList {
  baseUrl: string;
  models: Array<{ name: string; size: number; modifiedAt: string }>;
}

function renderConfigForm(config: ModelConfig, ollamaModels?: OllamaModelList): string {
  const isOllama = config.provider === 'ollama';
  const claudeModel = config.claude?.model ?? 'claude-sonnet-4-5-20250929';
  const ollamaBaseUrl = config.ollama?.baseUrl ?? 'http://localhost:11434';
  const ollamaModel = config.ollama?.model ?? 'qwen2.5-coder:latest';

  return `
    <div class="card">
      <h2>Model Provider</h2>
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

      <div style="margin-top:1rem">
        <button class="btn btn--sm" onclick="document.getElementById('json-editor').toggleAttribute('hidden')">
          Edit as JSON
        </button>
      </div>
      <div id="json-editor" hidden style="margin-top:1rem">
        <h3 style="margin-bottom:0.5rem">Edit model config (JSON)</h3>
        <form hx-put="/model/save-json"
              hx-target="#json-editor-result"
              style="display:flex;flex-direction:column;gap:0.5rem">
          <textarea name="config" rows="12" style="font-family:monospace;font-size:0.9em" required>${JSON.stringify(config, null, 2)}</textarea>
          <div style="display:flex;gap:0.5rem">
            <button type="submit" class="btn btn--sm">Save JSON</button>
            <button type="button" class="btn btn--sm" onclick="document.getElementById('json-editor').toggleAttribute('hidden')">Cancel</button>
          </div>
        </form>
        <div id="json-editor-result"></div>
      </div>
    </div>
  `;
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

function renderOllamaForm(baseUrl: string, model: string, modelList?: OllamaModelList): string {
  let modelOptions = '';
  if (modelList?.models) {
    modelOptions = `
      <optgroup label="Available Models">
        ${modelList.models.map((m) => `<option value="${m.name}">${m.name}</option>`).join('')}
      </optgroup>
    `;
  }

  return `
    <div class="form-group">
      <label for="ollama-base-url"><strong>Ollama Base URL</strong></label>
      <input type="text" id="ollama-base-url" name="ollamaBaseUrl" value="${baseUrl}" placeholder="http://localhost:11434">
      <small>URL of your Ollama instance</small>
    </div>

    <div class="form-group">
      <label for="ollama-model"><strong>Model Name</strong></label>
      <div style="display: flex; gap: 0.5rem;">
        ${modelList?.models ? `
          <select id="ollama-model" name="ollamaModel" style="flex: 1;">
            <option value="${model}">${model}</option>
            ${modelOptions}
          </select>
        ` : `
          <input type="text" id="ollama-model" name="ollamaModel" value="${model}" placeholder="qwen2.5-coder:latest" style="flex: 1;">
        `}
        <button type="button" class="btn"
                hx-get="/model/ollama/list"
                hx-include="[name='ollamaBaseUrl']"
                hx-target="#provider-config">
          🔄 Refresh Models
        </button>
      </div>
      <small>Select or enter an Ollama model name</small>
    </div>
  `;
}

app.get('/', async (c) => {
  try {
    const agentUrl = process.env.AGENT_API_URL ?? 'http://localhost:3001';
    const res = await fetch(`${agentUrl}/api/model/config`);
    const config = (await res.json()) as ModelConfig;

    const content = `
      <h1>Model Configuration</h1>
      ${renderConfigForm(config)}
    `;

    return c.html(layout('Model', content));
  } catch (err) {
    const content = `
      <h1>Model Configuration</h1>
      <div class="card">
        <p class="badge badge--red">Failed to load model configuration</p>
      </div>
    `;
    return c.html(layout('Model', content));
  }
});

// HTMX endpoint to update form when provider changes
app.get('/form', async (c) => {
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

// Fetch Ollama models
app.get('/ollama/list', async (c) => {
  const baseUrl = c.req.query('ollamaBaseUrl') ?? 'http://localhost:11434';

  try {
    const agentUrl = process.env.AGENT_API_URL ?? 'http://localhost:3001';
    const res = await fetch(`${agentUrl}/api/model/ollama/list?baseUrl=${encodeURIComponent(baseUrl)}`);

    if (!res.ok) {
      throw new Error('Failed to fetch models');
    }

    const data = (await res.json()) as OllamaModelList;

    // Re-fetch config to get current model
    const configRes = await fetch(`${agentUrl}/api/model/config`);
    const config = (await configRes.json()) as ModelConfig;
    const currentModel = config.ollama?.model ?? 'qwen2.5-coder:latest';

    return c.html(renderOllamaForm(baseUrl, currentModel, data));
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to fetch Ollama models';
    return c.html(`
      <div class="form-group">
        <p class="badge badge--red">❌ ${msg}</p>
        <p>Make sure Ollama is running and accessible at the specified URL</p>
      </div>
    `);
  }
});

// Save configuration
app.put('/save', async (c) => {
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
      throw new Error(error?.error ?? 'Failed to save configuration');
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

// Save configuration as raw JSON
app.put('/save-json', async (c) => {
  try {
    const body = await c.req.parseBody();
    const configText = body.config as string;
    if (!configText) return c.html('<p class="badge badge--red">Missing config</p>');

    let config: ModelConfig;
    try {
      config = JSON.parse(configText);
    } catch {
      return c.html('<p class="badge badge--red">Invalid JSON. Please fix and try again.</p>');
    }

    const agentUrl = process.env.AGENT_API_URL ?? 'http://localhost:3001';
    const res = await fetch(`${agentUrl}/api/model/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });

    if (!res.ok) {
      const error = (await res.json()) as { error?: string };
      return c.html(`<p class="badge badge--red">${error.error ?? 'Failed to save'}</p>`);
    }

    return c.html('<p class="badge badge--green">Configuration saved! Restart the agent for changes to take effect.</p>');
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to save configuration';
    return c.html(`<p class="badge badge--red">${msg}</p>`);
  }
});

export default app;
