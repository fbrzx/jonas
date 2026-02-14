import { Hono } from 'hono';
import { layout } from '../views/layout.js';

const app = new Hono();

const AGENT_URL = () => process.env.AGENT_API_URL ?? 'http://localhost:3001';

interface OAuthFlowConfig {
  provider: string;
  scopes: string[];
}

interface Skill {
  dirName: string;
  metadata: {
    name: string;
    description: string;
    version: string;
    author: string;
  };
  status: 'enabled' | 'disabled';
  hasTools: boolean;
  hasPrompt: boolean;
  config?: { requiredSecrets?: string[]; oauth?: Record<string, OAuthFlowConfig> };
  secretKeys?: string[];
}

// --- List page ---

function renderSkills(skills: Skill[]): string {
  if (skills.length === 0) {
    return '<p class="meta">No skills installed. Add skill directories to <code>/data/skills/</code>.</p>';
  }

  const rows = skills
    .map(
      (s) => `
      <tr>
        <td><a href="/skills/${encodeURIComponent(s.dirName)}"><strong>${s.metadata.name}</strong></a><br><span class="meta">${s.metadata.description}</span></td>
        <td><code>${s.metadata.version}</code></td>
        <td>
          ${s.hasPrompt ? '<span class="badge badge--blue">prompt</span> ' : ''}
          ${s.hasTools ? '<span class="badge badge--blue">tools</span>' : ''}
        </td>
        <td>
          <span class="badge ${s.status === 'enabled' ? 'badge--green' : 'badge--red'}">${s.status}</span>
        </td>
        <td>
          <button
            class="btn btn--sm"
            hx-post="/skills/${encodeURIComponent(s.dirName)}/${s.status === 'enabled' ? 'disable' : 'enable'}"
            hx-target="closest tr"
            hx-swap="outerHTML"
          >${s.status === 'enabled' ? 'Disable' : 'Enable'}</button>
        </td>
      </tr>`,
    )
    .join('');

  return `
    <table>
      <thead><tr><th>Skill</th><th>Version</th><th>Capabilities</th><th>Status</th><th>Action</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderSkillRow(s: Skill): string {
  const id = encodeURIComponent(s.dirName);
  return `
    <tr>
      <td><a href="/skills/${id}"><strong>${s.metadata.name}</strong></a><br><span class="meta">${s.metadata.description}</span></td>
      <td><code>${s.metadata.version}</code></td>
      <td>
        ${s.hasPrompt ? '<span class="badge badge--blue">prompt</span> ' : ''}
        ${s.hasTools ? '<span class="badge badge--blue">tools</span>' : ''}
      </td>
      <td>
        <span class="badge ${s.status === 'enabled' ? 'badge--green' : 'badge--red'}">${s.status}</span>
      </td>
      <td>
        <button
          class="btn btn--sm"
          hx-post="/skills/${id}/${s.status === 'enabled' ? 'disable' : 'enable'}"
          hx-target="closest tr"
          hx-swap="outerHTML"
        >${s.status === 'enabled' ? 'Disable' : 'Enable'}</button>
      </td>
    </tr>`;
}

app.get('/skills', async (c) => {
  try {
    const res = await fetch(`${AGENT_URL()}/api/skills`);
    const data = (await res.json()) as Skill[];
    return c.html(layout('Skills', `<h1>Skills</h1>${renderSkills(data)}`));
  } catch {
    return c.html(
      layout('Skills', '<h1>Skills</h1><p class="badge badge--red">Agent unreachable</p>'),
    );
  }
});

// --- Detail page ---

function renderConfigSection(skill: Skill): string {
  const required = (skill.config?.requiredSecrets ?? []).filter((k): k is string => typeof k === 'string');
  const oauthKeys = skill.config?.oauth ?? {};
  const allSecretKeys = skill.secretKeys ?? [];
  const setKeys = allSecretKeys.filter((k) => !k.startsWith('__oauth_'));
  const id = encodeURIComponent(skill.dirName);

  if (required.length === 0 && setKeys.length === 0 && Object.keys(oauthKeys).length === 0) {
    return '<p class="meta">This skill has no configuration keys.</p>';
  }

  const allKeys = [...new Set([...required, ...Object.keys(oauthKeys), ...setKeys])];
  const unsetKeys = allKeys.filter((k) => !setKeys.includes(k) && !oauthKeys[k]);

  const rows = allKeys
    .map((key) => {
      const isSet = setKeys.includes(key);
      const oauth = oauthKeys[key];

      const hasOAuthCreds = oauth && allSecretKeys.includes(`__oauth_${key}_client_id`);

      let actionHtml: string;
      if (oauth) {
        if (isSet) {
          actionHtml = `
            <span class="meta">via ${oauth.provider}</span>
            <button class="btn btn--sm btn--danger" hx-post="/skills/${id}/values/${encodeURIComponent(key)}/delete" hx-target="#config-section" hx-swap="innerHTML">Disconnect</button>`;
        } else if (hasOAuthCreds) {
          const connectParams = new URLSearchParams({
            provider: oauth.provider,
            scopes: oauth.scopes.join(','),
          });
          actionHtml = `
            <a href="/oauth/connect/${encodeURIComponent(skill.dirName)}/${encodeURIComponent(key)}?${connectParams.toString()}" class="btn btn--sm">Connect ${oauth.provider}</a>`;
        } else {
          actionHtml = `
            <details style="margin-top:0.25rem">
              <summary class="btn btn--sm" style="display:inline-block;cursor:pointer">Setup ${oauth.provider}</summary>
              <div class="card" style="margin-top:0.5rem">
                <p class="meta" style="margin-bottom:0.5rem">
                  1. Create an OAuth app in the ${oauth.provider} developer console<br>
                  2. Set redirect URI to: <code>http://localhost:3000/oauth/callback</code><br>
                  3. Paste the credentials below
                </p>
                <form method="post" action="/skills/${id}/oauth-setup/${encodeURIComponent(key)}"
                      style="display:flex;flex-direction:column;gap:0.5rem;max-width:400px">
                  <label class="meta">Client ID</label>
                  <input type="text" name="clientId" required placeholder="your-client-id">
                  <label class="meta">Client Secret</label>
                  <input type="text" name="clientSecret" required placeholder="your-client-secret">
                  <button type="submit" class="btn" style="align-self:flex-start">Save &amp; Connect</button>
                </form>
              </div>
            </details>`;
        }
      } else if (isSet) {
        actionHtml = `<button class="btn btn--sm btn--danger" hx-post="/skills/${id}/values/${encodeURIComponent(key)}/delete" hx-target="#config-section" hx-swap="innerHTML">Remove</button>`;
      } else {
        actionHtml = '';
      }

      return `
        <tr>
          <td><code>${key}</code></td>
          <td>
            <span class="badge ${isSet ? 'badge--green' : 'badge--red'}">${isSet ? 'set' : 'missing'}</span>
          </td>
          <td>${actionHtml}</td>
        </tr>`;
    })
    .join('');

  const table = `
    <table>
      <thead><tr><th>Key</th><th>Status</th><th>Action</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

  const options = unsetKeys
    .map((k) => `<option value="${k}">${k}</option>`)
    .join('');

  const form = `
    <h2 style="margin-top:1rem">Set a value</h2>
    <form hx-post="/skills/${id}/values"
          hx-target="#config-section" hx-swap="innerHTML"
          style="display:flex;flex-direction:column;gap:0.5rem;max-width:500px">
      <label class="meta">Key</label>
      <div style="display:flex;gap:0.5rem">
        <select name="key" style="flex:1" required>
          <option value="">Select a key…</option>
          ${options}
        </select>
        <input type="text" name="customKey" placeholder="or type custom key" style="flex:1;max-width:none">
      </div>
      <label class="meta">Value</label>
      <textarea name="value" placeholder="Paste value here…" required></textarea>
      <button type="submit" class="btn" style="align-self:flex-start">Save</button>
    </form>`;

  return table + form;
}

function renderSkillDetail(skill: Skill): string {
  const id = encodeURIComponent(skill.dirName);
  return `
    <p><a href="/skills">&larr; Back to Skills</a></p>
    <h1>${skill.metadata.name}</h1>

    <div class="card">
      <p>${skill.metadata.description}</p>
      <p class="meta" style="margin-top:0.5rem">
        Version: <code>${skill.metadata.version}</code> &middot; Author: ${skill.metadata.author}
      </p>
      <p style="margin-top:0.5rem">
        ${skill.hasPrompt ? '<span class="badge badge--blue">prompt</span> ' : ''}
        ${skill.hasTools ? '<span class="badge badge--blue">tools</span>' : ''}
        <span class="badge ${skill.status === 'enabled' ? 'badge--green' : 'badge--red'}">${skill.status}</span>
      </p>
      <div style="margin-top:0.75rem">
        <button class="btn btn--sm"
          hx-post="/skills/${id}/${skill.status === 'enabled' ? 'disable' : 'enable'}"
          hx-target="body"
          hx-swap="none"
          hx-on::after-request="location.reload()"
        >${skill.status === 'enabled' ? 'Disable' : 'Enable'}</button>
      </div>
    </div>

    <h2>Configuration</h2>
    <div id="config-section">
      ${renderConfigSection(skill)}
    </div>`;
}

app.get('/skills/:id', async (c) => {
  const id = c.req.param('id');
  try {
    const res = await fetch(`${AGENT_URL()}/api/skills/${encodeURIComponent(id)}`);
    if (!res.ok) return c.html(layout('Skill Not Found', '<h1>Skill not found</h1>'), 404);
    const skill = (await res.json()) as Skill;
    return c.html(layout(skill.metadata.name, renderSkillDetail(skill)));
  } catch {
    return c.html(
      layout('Skills', '<h1>Skills</h1><p class="badge badge--red">Agent unreachable</p>'),
    );
  }
});

// --- HTMX toggle endpoints ---

app.post('/skills/:id/enable', async (c) => {
  const id = c.req.param('id');
  try {
    await fetch(`${AGENT_URL()}/api/skills/${encodeURIComponent(id)}/enable`, { method: 'POST' });
    const res = await fetch(`${AGENT_URL()}/api/skills`);
    const skills = (await res.json()) as Skill[];
    const skill = skills.find((s) => s.dirName === id);
    if (!skill) return c.text('Skill not found', 404);
    return c.html(renderSkillRow(skill));
  } catch {
    return c.text('Agent unreachable', 502);
  }
});

app.post('/skills/:id/disable', async (c) => {
  const id = c.req.param('id');
  try {
    await fetch(`${AGENT_URL()}/api/skills/${encodeURIComponent(id)}/disable`, { method: 'POST' });
    const res = await fetch(`${AGENT_URL()}/api/skills`);
    const skills = (await res.json()) as Skill[];
    const skill = skills.find((s) => s.dirName === id);
    if (!skill) return c.text('Skill not found', 404);
    return c.html(renderSkillRow(skill));
  } catch {
    return c.text('Agent unreachable', 502);
  }
});

// --- Value management (proxy to agent API) ---

app.post('/skills/:id/values', async (c) => {
  const id = c.req.param('id');
  try {
    const body = await c.req.parseBody();
    const key = (body.customKey as string) || (body.key as string);
    const value = body.value as string;
    if (!key || !value) return c.text('Missing key or value', 400);

    await fetch(`${AGENT_URL()}/api/skills/${encodeURIComponent(id)}/values`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value }),
    });

    const res = await fetch(`${AGENT_URL()}/api/skills/${encodeURIComponent(id)}`);
    const skill = (await res.json()) as Skill;
    return c.html(renderConfigSection(skill));
  } catch {
    return c.text('Agent unreachable', 502);
  }
});

// --- Inline OAuth provider setup ---

app.post('/skills/:id/oauth-setup/:key', async (c) => {
  const id = c.req.param('id');
  const key = c.req.param('key');
  try {
    const body = await c.req.parseBody();
    const clientId = body.clientId as string;
    const clientSecret = body.clientSecret as string;
    if (!clientId || !clientSecret) return c.text('Missing clientId or clientSecret', 400);

    // Store inline OAuth credentials
    await fetch(`${AGENT_URL()}/api/skills/${encodeURIComponent(id)}/oauth-provider/${encodeURIComponent(key)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, clientSecret }),
    });

    // Look up the skill to get provider and scopes
    const skillRes = await fetch(`${AGENT_URL()}/api/skills/${encodeURIComponent(id)}`);
    const skill = (await skillRes.json()) as Skill;
    const oauth = skill.config?.oauth?.[key];
    if (!oauth) return c.redirect(`/skills/${encodeURIComponent(id)}`);

    // Redirect to the connect flow
    const connectParams = new URLSearchParams({
      provider: oauth.provider,
      scopes: oauth.scopes.join(','),
    });
    return c.redirect(`/oauth/connect/${encodeURIComponent(id)}/${encodeURIComponent(key)}?${connectParams.toString()}`);
  } catch {
    return c.text('Agent unreachable', 502);
  }
});

app.post('/skills/:id/values/:key/delete', async (c) => {
  const id = c.req.param('id');
  const key = c.req.param('key');
  try {
    await fetch(`${AGENT_URL()}/api/skills/${encodeURIComponent(id)}/values/${encodeURIComponent(key)}`, {
      method: 'DELETE',
    });

    const res = await fetch(`${AGENT_URL()}/api/skills/${encodeURIComponent(id)}`);
    const skill = (await res.json()) as Skill;
    return c.html(renderConfigSection(skill));
  } catch {
    return c.text('Agent unreachable', 502);
  }
});

export default app;
