import { Hono } from 'hono';
import { layout } from '../views/layout.js';

const app = new Hono();
const AGENT_API_URL = process.env.AGENT_API_URL ?? 'http://localhost:3001';

interface AgentRow {
  id: string;
  name: string;
  description: string | null;
  provider: 'claude' | 'ollama';
  claudeModel: string | null;
  ollamaBaseUrl: string | null;
  ollamaModel: string | null;
  systemPromptOverride: string | null;
  isDefault: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface AgentListItem {
  row: AgentRow;
  active: boolean;
  providerName: string;
  uptime: number;
  activeConversations: number;
}

function modelLabel(row: AgentRow): string {
  if (row.provider === 'ollama') {
    return row.ollamaModel ?? 'unknown model';
  }
  return row.claudeModel ?? 'unknown model';
}

function providerBadge(row: AgentRow): string {
  const label = row.provider === 'ollama' ? 'Ollama' : 'Claude';
  const cls = row.provider === 'ollama' ? 'badge--yellow' : 'badge--blue';
  return `<span class="badge ${cls}">${label}</span>`;
}

function statusDot(item: AgentListItem): string {
  if (!item.row.enabled) return '<span style="color:#f85149">○ Disabled</span>';
  if (item.active) return '<span style="color:#3fb950">● Active</span>';
  return '<span style="color:#d29922">○ Inactive</span>';
}

function renderAgentCard(item: AgentListItem): string {
  const { row } = item;
  const isDefault = row.isDefault;
  return `
    <div class="card" id="agent-${row.id}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;flex-wrap:wrap">
        <div style="min-width:0">
          <div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;margin-bottom:0.25rem">
            <strong style="font-size:1rem;color:#f0f6fc">${escHtml(row.name)}</strong>
            ${isDefault ? '<span class="badge badge--green">DEFAULT</span>' : ''}
            ${providerBadge(row)}
            ${statusDot(item)}
          </div>
          <div class="meta" style="margin-bottom:0.25rem">${escHtml(modelLabel(row))}</div>
          ${row.description ? `<div class="meta">${escHtml(row.description)}</div>` : ''}
          ${item.active ? `<div class="meta">${item.activeConversations} active conversation${item.activeConversations !== 1 ? 's' : ''}</div>` : ''}
        </div>
        <div class="table-actions" style="flex-shrink:0">
          ${!isDefault ? `
            <button class="btn btn--sm"
                    hx-post="/agents/${row.id}/set-default"
                    hx-target="#agents-list"
                    hx-swap="outerHTML"
                    hx-confirm="Set '${escHtml(row.name)}' as the default agent?">
              Set Default
            </button>
          ` : ''}
          <button class="btn btn--sm btn--primary" onclick="openEditModal(${JSON.stringify(row)})">Edit</button>
          ${!isDefault ? `
            <button class="btn btn--sm btn--danger"
                    hx-delete="/agents/${row.id}"
                    hx-target="#agents-list"
                    hx-swap="outerHTML"
                    hx-confirm="Delete agent '${escHtml(row.name)}'? This cannot be undone.">
              Delete
            </button>
          ` : ''}
        </div>
      </div>
    </div>
  `;
}

function renderAgentList(items: AgentListItem[]): string {
  if (items.length === 0) {
    return `<div id="agents-list"><p class="meta">No agents configured.</p></div>`;
  }
  return `<div id="agents-list">${items.map(renderAgentCard).join('')}</div>`;
}

function renderOllamaFields(row?: AgentRow): string {
  return `
    <div id="ollama-fields">
      <div class="form-group">
        <label for="edit-ollama-url">Ollama Base URL</label>
        <input type="text" id="edit-ollama-url" name="ollamaBaseUrl"
               value="${escHtml(row?.ollamaBaseUrl ?? 'http://localhost:11434')}"
               placeholder="http://localhost:11434">
      </div>
      <div class="form-group">
        <label for="edit-ollama-model">Model Name</label>
        <input type="text" id="edit-ollama-model" name="ollamaModel"
               value="${escHtml(row?.ollamaModel ?? '')}"
               placeholder="qwen2.5-coder:latest">
      </div>
    </div>
  `;
}

function renderClaudeFields(row?: AgentRow): string {
  return `
    <div id="claude-fields">
      <div class="form-group">
        <label for="edit-claude-model">Claude Model</label>
        <input type="text" id="edit-claude-model" name="claudeModel"
               value="${escHtml(row?.claudeModel ?? 'claude-sonnet-4-6')}"
               placeholder="claude-sonnet-4-6">
        <small>Common: claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5-20251001</small>
      </div>
    </div>
  `;
}

function escHtml(str: string | null | undefined): string {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

app.get('/agents', async (c) => {
  let items: AgentListItem[] = [];
  let errorMsg = '';

  try {
    const res = await fetch(`${AGENT_API_URL}/api/agents`);
    const data = await res.json() as { agents?: AgentListItem[]; error?: string };
    items = data.agents ?? [];
  } catch {
    errorMsg = 'Agent unreachable — could not load agents';
  }

  const content = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;flex-wrap:wrap;gap:0.5rem">
      <h1 style="margin:0">Agents</h1>
      <button class="btn btn--primary btn--sm" onclick="openCreateModal()">+ New Agent</button>
    </div>

    ${errorMsg ? `<p class="badge badge--red">${errorMsg}</p>` : ''}

    <div class="info-box">
      Each agent has its own model configuration. Channels can be assigned a specific agent;
      the <strong>default</strong> agent handles all unassigned channels.
    </div>

    ${renderAgentList(items)}

    <!-- Create/Edit modal -->
    <div id="agent-modal" class="modal-overlay" hidden>
      <div class="modal-card" style="width:min(560px,100%)">
        <h3 id="agent-modal-title" class="modal-title">New Agent</h3>
        <form id="agent-form" style="margin-top:0.75rem">
          <input type="hidden" id="agent-form-id" name="id" value="">

          <div class="form-group">
            <label for="edit-name">Name</label>
            <input type="text" id="edit-name" name="name" placeholder="coding-assistant" required style="max-width:100%">
            <small>Lowercase, no spaces (e.g. "coding-assistant")</small>
          </div>

          <div class="form-group">
            <label for="edit-desc">Description</label>
            <input type="text" id="edit-desc" name="description" placeholder="Optional description" style="max-width:100%">
          </div>

          <div class="form-group">
            <label>Provider</label>
            <div style="display:flex;gap:1.5rem;margin-top:0.25rem">
              <label>
                <input type="radio" name="provider" value="claude" checked
                       onchange="toggleProviderFields('claude')"> Claude (OAuth)
              </label>
              <label>
                <input type="radio" name="provider" value="ollama"
                       onchange="toggleProviderFields('ollama')"> Ollama (local)
              </label>
            </div>
          </div>

          <div id="provider-fields">
            ${renderClaudeFields()}
          </div>

          <div class="form-group">
            <label for="edit-system-prompt">System prompt override <span class="meta">(optional)</span></label>
            <textarea id="edit-system-prompt" name="systemPromptOverride" rows="3"
                      placeholder="Extra instructions appended to the system prompt for this agent..."></textarea>
          </div>

          <div class="form-group" style="display:flex;align-items:center;gap:0.5rem">
            <input type="checkbox" id="edit-is-default" name="isDefault" style="width:auto">
            <label for="edit-is-default" style="margin:0">Set as default agent</label>
          </div>

          <div id="agent-form-result" style="margin-bottom:0.5rem"></div>

          <div style="display:flex;gap:0.5rem;justify-content:flex-end">
            <button type="button" class="btn btn--sm" onclick="closeAgentModal()">Cancel</button>
            <button type="button" class="btn btn--sm btn--primary" id="agent-submit-btn" onclick="submitAgentForm()">Create Agent</button>
          </div>
        </form>
      </div>
    </div>

    <script>
      const claudeFieldsHtml = ${JSON.stringify(renderClaudeFields())};
      const ollamaFieldsHtml = ${JSON.stringify(renderOllamaFields())};

      function toggleProviderFields(provider) {
        document.getElementById('provider-fields').innerHTML =
          provider === 'ollama' ? ollamaFieldsHtml : claudeFieldsHtml;
      }

      function openCreateModal() {
        const modal = document.getElementById('agent-modal');
        document.getElementById('agent-modal-title').textContent = 'New Agent';
        document.getElementById('agent-submit-btn').textContent = 'Create Agent';
        document.getElementById('agent-form').reset();
        document.getElementById('agent-form-id').value = '';
        document.getElementById('provider-fields').innerHTML = claudeFieldsHtml;
        document.querySelectorAll('[name="provider"]').forEach(r => {
          r.checked = r.value === 'claude';
        });
        document.getElementById('agent-form-result').innerHTML = '';
        modal.removeAttribute('hidden');
      }

      function openEditModal(row) {
        const modal = document.getElementById('agent-modal');
        document.getElementById('agent-modal-title').textContent = 'Edit Agent';
        document.getElementById('agent-submit-btn').textContent = 'Save Changes';
        document.getElementById('agent-form-id').value = row.id;
        document.getElementById('edit-name').value = row.name;
        document.getElementById('edit-desc').value = row.description || '';
        document.getElementById('edit-system-prompt').value = row.systemPromptOverride || '';
        document.getElementById('edit-is-default').checked = row.isDefault;

        document.querySelectorAll('[name="provider"]').forEach(r => {
          r.checked = r.value === row.provider;
        });

        if (row.provider === 'ollama') {
          document.getElementById('provider-fields').innerHTML = ${JSON.stringify(renderOllamaFields())};
          document.getElementById('edit-ollama-url').value = row.ollamaBaseUrl || '';
          document.getElementById('edit-ollama-model').value = row.ollamaModel || '';
        } else {
          document.getElementById('provider-fields').innerHTML = claudeFieldsHtml;
          document.getElementById('edit-claude-model').value = row.claudeModel || '';
        }

        document.getElementById('agent-form-result').innerHTML = '';
        modal.removeAttribute('hidden');
      }

      function closeAgentModal() {
        document.getElementById('agent-modal').setAttribute('hidden', '');
      }

      async function submitAgentForm() {
        const form = document.getElementById('agent-form');
        const id = document.getElementById('agent-form-id').value;
        const isEdit = !!id;
        const resultEl = document.getElementById('agent-form-result');
        const btn = document.getElementById('agent-submit-btn');

        const provider = form.querySelector('[name="provider"]:checked').value;
        const payload = {
          name: form.querySelector('[name="name"]').value.trim(),
          description: form.querySelector('[name="description"]').value.trim() || null,
          provider,
          systemPromptOverride: form.querySelector('[name="systemPromptOverride"]').value.trim() || null,
          isDefault: form.querySelector('[name="isDefault"]').checked,
        };

        if (provider === 'claude') {
          payload.claudeModel = form.querySelector('[name="claudeModel"]')?.value.trim() || null;
        } else {
          payload.ollamaBaseUrl = form.querySelector('[name="ollamaBaseUrl"]')?.value.trim() || null;
          payload.ollamaModel = form.querySelector('[name="ollamaModel"]')?.value.trim() || null;
        }

        if (!payload.name) {
          resultEl.innerHTML = '<p class="badge badge--red">Name is required</p>';
          return;
        }

        btn.disabled = true;
        try {
          const url = isEdit ? '/agents/' + id : '/agents/create';
          const method = isEdit ? 'PUT' : 'POST';
          const res = await fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          const data = await res.json();
          if (!res.ok) {
            resultEl.innerHTML = '<p class="badge badge--red">' + (data.error || 'Failed') + '</p>';
          } else {
            closeAgentModal();
            window.location.reload();
          }
        } catch (err) {
          resultEl.innerHTML = '<p class="badge badge--red">Request failed</p>';
        } finally {
          btn.disabled = false;
        }
      }

      // Close modal on overlay click
      document.getElementById('agent-modal').addEventListener('click', function(e) {
        if (e.target === this) closeAgentModal();
      });
    </script>
  `;

  return c.html(layout('Agents', content));
});

// HTMX: Set default
app.post('/agents/:id/set-default', async (c) => {
  const id = c.req.param('id');
  try {
    const res = await fetch(`${AGENT_API_URL}/api/agents/${id}/set-default`, { method: 'POST' });
    if (!res.ok) throw new Error('Failed');
  } catch {
    // ignore, reload list anyway
  }
  return reloadList(c);
});

// HTMX: Delete
app.delete('/agents/:id', async (c) => {
  const id = c.req.param('id');
  try {
    await fetch(`${AGENT_API_URL}/api/agents/${id}`, { method: 'DELETE' });
  } catch {
    // ignore
  }
  return reloadList(c);
});

// JSON: Create
app.post('/agents/create', async (c) => {
  try {
    const body = await c.req.json();
    const res = await fetch(`${AGENT_API_URL}/api/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) return c.json(data, res.status as 400 | 500);
    return c.json(data, 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to create agent';
    return c.json({ error: msg }, 500);
  }
});

// JSON: Update
app.put('/agents/:id', async (c) => {
  const id = c.req.param('id');
  try {
    const body = await c.req.json();
    const res = await fetch(`${AGENT_API_URL}/api/agents/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) return c.json(data, res.status as 400 | 500);
    return c.json(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to update agent';
    return c.json({ error: msg }, 500);
  }
});

async function reloadList(c: Parameters<typeof app.get>[1] extends (c: infer C, ...args: unknown[]) => unknown ? C : never): Promise<Response> {
  let items: AgentListItem[] = [];
  try {
    const res = await fetch(`${AGENT_API_URL}/api/agents`);
    const data = await res.json() as { agents?: AgentListItem[] };
    items = data.agents ?? [];
  } catch {
    // ignore
  }
  return c.html(renderAgentList(items));
}

export default app;
