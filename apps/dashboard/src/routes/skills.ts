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

interface Connection {
  skillDirName: string;
  skillName: string;
  secretKey: string;
  provider: string;
  connected: boolean;
  scopes: string[];
}

// --- List page ---

function renderConnectionsTable(connections: Connection[]): string {
  if (connections.length === 0) {
    return '<p class="meta">No OAuth connections configured across skills.</p>';
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
            hx-post="/skills/${encodeURIComponent(conn.skillDirName)}/values/${encodeURIComponent(conn.secretKey)}/delete"
            hx-target="body"
            hx-swap="none"
            hx-on::after-request="location.reload()"
            hx-confirm="Disconnect ${conn.provider} from ${conn.skillName}?"
          >Disconnect</button>`;
      } else {
        actionHtml = `<a href="${skillUrl}" class="btn btn--sm">Setup</a>`;
      }

      return `
        <tr>
          <td><a href="${skillUrl}"><strong>${conn.skillName}</strong></a></td>
          <td><code>${conn.secretKey}</code></td>
          <td>${conn.provider}</td>
          <td><span class="badge ${conn.connected ? 'badge--green' : 'badge--red'}">${conn.connected ? 'connected' : 'not connected'}</span></td>
          <td style="display:flex;gap:0.5rem">${actionHtml}</td>
        </tr>`;
    })
    .join('');

  return `
    <table>
      <thead><tr><th>Skill</th><th>Key</th><th>Provider</th><th>Status</th><th>Action</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

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

    const importForm = `
      <div style="margin-bottom:1rem">
        <button class="btn btn--sm" onclick="document.getElementById('import-form').toggleAttribute('hidden')">
          Import Skill (.zip)
        </button>
      </div>
      <div id="import-form" hidden style="margin-bottom:1.5rem">
        <div class="card">
          <h3 style="margin-bottom:0.5rem">Import Skill from .zip</h3>
          <form action="/skills/import" method="post" enctype="multipart/form-data"
                style="display:flex;flex-direction:column;gap:0.5rem;max-width:500px">
            <input type="file" name="file" accept=".zip" required>
            <label style="display:flex;align-items:center;gap:0.5rem">
              <input type="checkbox" name="overwrite" value="true">
              <span class="meta">Overwrite if skill already exists</span>
            </label>
            <div style="display:flex;gap:0.5rem">
              <button type="submit" class="btn btn--sm">Import</button>
              <button type="button" class="btn btn--sm" onclick="document.getElementById('import-form').toggleAttribute('hidden')">Cancel</button>
            </div>
          </form>
        </div>
      </div>`;

    return c.html(layout('Skills', `<h1>Skills</h1>${importForm}${renderSkills(data)}`));
  } catch {
    return c.html(
      layout('Skills', '<h1>Skills</h1><p class="badge badge--red">Agent unreachable</p>'),
    );
  }
});

// --- Detail page ---

function renderConfigSection(skill: Skill): string {
  const id = encodeURIComponent(skill.dirName);
  const allVaultKeys = skill.secretKeys ?? [];
  const oauthEntries = Object.entries(skill.config?.oauth ?? {});
  const requiredSecrets = (skill.config?.requiredSecrets ?? []).filter(
    (k): k is string => typeof k === 'string',
  );

  // User-facing keys: exclude internal __oauth_ prefix keys
  const userKeys = allVaultKeys.filter((k) => !k.startsWith('__oauth_'));

  // Non-OAuth config keys = requiredSecrets + any user vault keys not covered by oauth
  const oauthKeyNames = new Set(oauthEntries.map(([k]) => k));
  const configKeys = [...new Set([...requiredSecrets, ...userKeys])].filter(
    (k) => !oauthKeyNames.has(k),
  );

  const hasOAuth = oauthEntries.length > 0;
  const hasConfig = configKeys.length > 0;

  if (!hasOAuth && !hasConfig) {
    return '<p class="meta">This skill requires no configuration.</p>';
  }

  let html = '';

  // --- OAuth connections ---
  if (hasOAuth) {
    html += '<h2>Connections</h2>';
    const oauthRows = oauthEntries
      .map(([key, flow]) => {
        const tokenStored = allVaultKeys.includes(key);
        const credsStored = allVaultKeys.includes(`__oauth_${key}_client_id`);

        let statusBadge: string;
        let actionHtml: string;

        if (tokenStored) {
          // Connected — token is stored, agent can use this
          statusBadge = '<span class="badge badge--green">connected</span>';
          actionHtml = `
            <button class="btn btn--sm btn--danger"
              hx-post="/skills/${id}/values/${encodeURIComponent(key)}/delete"
              hx-target="#config-section" hx-swap="innerHTML"
            >Disconnect</button>`;
        } else if (credsStored) {
          // Credentials saved, ready to connect
          const connectParams = new URLSearchParams({
            provider: flow.provider,
            scopes: flow.scopes.join(','),
          });
          statusBadge = '<span class="badge badge--yellow">ready to connect</span>';
          actionHtml = `
            <a href="/oauth/connect/${encodeURIComponent(skill.dirName)}/${encodeURIComponent(key)}?${connectParams.toString()}"
               class="btn btn--sm">Connect ${flow.provider}</a>`;
        } else {
          // No credentials yet — need setup
          statusBadge = '<span class="badge badge--red">needs setup</span>';
          actionHtml = `
            <button class="btn btn--sm"
              onclick="this.closest('tr').nextElementSibling.toggleAttribute('hidden')"
            >Setup ${flow.provider}</button>`;
        }

        // Inline setup panel (hidden by default, shown when "Setup" clicked)
        const setupPanel = `
          <tr class="setup-panel" hidden>
            <td colspan="4">
              <div class="card" style="margin:0.5rem 0">
                <p class="meta" style="margin-bottom:0.5rem">
                  1. Go to the <strong>${flow.provider}</strong> developer console and create an OAuth app<br>
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
            </td>
          </tr>`;

        return `
          <tr>
            <td><code>${key}</code></td>
            <td>${flow.provider}</td>
            <td>${statusBadge}</td>
            <td>${actionHtml}</td>
          </tr>
          ${tokenStored ? '' : credsStored ? '' : setupPanel}`;
      })
      .join('');

    html += `
      <table>
        <thead><tr><th>Key</th><th>Provider</th><th>Status</th><th>Action</th></tr></thead>
        <tbody>${oauthRows}</tbody>
      </table>`;
  }

  // --- API keys / config values ---
  if (hasConfig) {
    html += `<h2 style="margin-top:1.5rem">Configuration</h2>`;

    const configRows = configKeys
      .map((key) => {
        const isSet = userKeys.includes(key);
        const actionHtml = isSet
          ? `<button class="btn btn--sm btn--danger"
               hx-post="/skills/${id}/values/${encodeURIComponent(key)}/delete"
               hx-target="#config-section" hx-swap="innerHTML"
             >Remove</button>`
          : '';
        return `
          <tr>
            <td><code>${key}</code></td>
            <td><span class="badge ${isSet ? 'badge--green' : 'badge--red'}">${isSet ? 'set' : 'missing'}</span></td>
            <td>${actionHtml}</td>
          </tr>`;
      })
      .join('');

    html += `
      <table>
        <thead><tr><th>Key</th><th>Status</th><th>Action</th></tr></thead>
        <tbody>${configRows}</tbody>
      </table>`;

    const unsetKeys = configKeys.filter((k) => !userKeys.includes(k));
    const options = unsetKeys.map((k) => `<option value="${k}">${k}</option>`).join('');

    html += `
      <div style="margin-top:1rem">
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
        </form>
      </div>`;
  }

  return html;
}

function renderSkillDetail(skill: Skill, connections: Connection[]): string {
  const id = encodeURIComponent(skill.dirName);
  const configJson = skill.config ? JSON.stringify(skill.config, null, 2) : '{}';

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
      <div style="margin-top:0.75rem;display:flex;gap:0.5rem;flex-wrap:wrap">
        <button class="btn btn--sm"
          hx-post="/skills/${id}/${skill.status === 'enabled' ? 'disable' : 'enable'}"
          hx-target="body"
          hx-swap="none"
          hx-on::after-request="location.reload()"
        >${skill.status === 'enabled' ? 'Disable' : 'Enable'}</button>

        <button class="btn btn--sm"
          onclick="document.getElementById('config-editor').toggleAttribute('hidden')"
        >Edit Config</button>

        <a href="/skills/${id}/export"
           download="${skill.dirName}.zip"
           class="btn btn--sm">Export (.zip)</a>

        <button class="btn btn--sm btn--danger"
          hx-delete="/skills/${id}"
          hx-confirm="Are you sure you want to delete this skill? This cannot be undone."
          hx-target="body"
          hx-swap="none"
          hx-on::after-request="window.location.href='/skills'"
        >Delete Skill</button>
      </div>

      <div id="config-editor" hidden style="margin-top:1rem">
        <h3 style="margin-bottom:0.5rem">Edit config.json</h3>
        <form hx-put="/skills/${id}/config"
              hx-target="#config-editor"
              hx-swap="outerHTML"
              style="display:flex;flex-direction:column;gap:0.5rem">
          <textarea name="config" rows="15" style="font-family:monospace;font-size:0.9em" required>${configJson}</textarea>
          <div style="display:flex;gap:0.5rem">
            <button type="submit" class="btn btn--sm">Save Config</button>
            <button type="button" class="btn btn--sm" onclick="this.closest('#config-editor').toggleAttribute('hidden')">Cancel</button>
          </div>
        </form>
      </div>
    </div>

    <div id="config-section">
      ${renderConfigSection(skill)}
    </div>

    <h2 style="margin-top:2rem">All Connections</h2>
    <div class="card">
      ${renderConnectionsTable(connections)}
    </div>`;
}

app.get('/skills/:id', async (c) => {
  const id = c.req.param('id');
  try {
    const [skillRes, connectionsRes] = await Promise.all([
      fetch(`${AGENT_URL()}/api/skills/${encodeURIComponent(id)}`),
      fetch(`${AGENT_URL()}/api/connections`),
    ]);

    if (!skillRes.ok) return c.html(layout('Skill Not Found', '<h1>Skill not found</h1>'), 404);

    const skill = (await skillRes.json()) as Skill;
    const connections = connectionsRes.ok ? ((await connectionsRes.json()) as Connection[]) : [];

    return c.html(layout(skill.metadata.name, renderSkillDetail(skill, connections)));
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

// --- Config management ---

app.put('/skills/:id/config', async (c) => {
  const id = c.req.param('id');
  try {
    const body = await c.req.parseBody();
    const configText = body.config as string;
    if (!configText) return c.text('Missing config', 400);

    let config;
    try {
      config = JSON.parse(configText);
    } catch {
      return c.html(
        '<div id="config-editor"><p class="badge badge--red">Invalid JSON. Please fix and try again.</p></div>',
      );
    }

    await fetch(`${AGENT_URL()}/api/skills/${encodeURIComponent(id)}/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });

    return c.html(
      '<div id="config-editor" hidden><p class="badge badge--green">Config saved successfully!</p></div>',
    );
  } catch {
    return c.text('Agent unreachable', 502);
  }
});

// --- Delete skill ---

app.delete('/skills/:id', async (c) => {
  const id = c.req.param('id');
  try {
    await fetch(`${AGENT_URL()}/api/skills/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    return c.text('', 200);
  } catch {
    return c.text('Agent unreachable', 502);
  }
});

// --- Export skill ---

app.get('/skills/:id/export', async (c) => {
  const id = c.req.param('id');
  try {
    const res = await fetch(`${AGENT_URL()}/api/skills/${encodeURIComponent(id)}/export`);
    if (!res.ok) {
      return c.text('Skill not found', 404);
    }

    const buffer = await res.arrayBuffer();
    const filename = `${id}.zip`;

    return c.body(buffer, 200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"`,
    });
  } catch {
    return c.text('Agent unreachable', 502);
  }
});

// --- Import skill ---

app.post('/skills/import', async (c) => {
  try {
    const body = await c.req.parseBody();
    const file = body.file;

    if (!file || typeof file === 'string') {
      return c.html(
        layout(
          'Import Failed',
          `<h1>Import Failed</h1>
           <p class="badge badge--red">No file uploaded</p>
           <p><a href="/skills">&larr; Back to Skills</a></p>`,
        ),
      );
    }

    // Create new FormData and properly forward the file
    const formData = new FormData();
    const arrayBuffer = await file.arrayBuffer();
    const blob = new Blob([arrayBuffer], { type: 'application/zip' });
    formData.append('file', blob, file.name || 'skill.zip');

    if (body.overwrite === 'true') {
      formData.append('overwrite', 'true');
    }

    const res = await fetch(`${AGENT_URL()}/api/skills/import`, {
      method: 'POST',
      body: formData,
    });

    if (!res.ok) {
      const error = (await res.json()) as { error?: string };
      return c.html(
        layout(
          'Import Failed',
          `<h1>Import Failed</h1>
           <p class="badge badge--red">${error.error || 'Unknown error'}</p>
           <p><a href="/skills">&larr; Back to Skills</a></p>`,
        ),
      );
    }

    const result = (await res.json()) as { skill: { dirName: string } };
    return c.redirect(`/skills/${encodeURIComponent(result.skill.dirName)}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Agent unreachable';
    return c.html(
      layout(
        'Import Failed',
        `<h1>Import Failed</h1>
         <p class="badge badge--red">${message}</p>
         <p><a href="/skills">&larr; Back to Skills</a></p>`,
      ),
    );
  }
});

export default app;
