import { Hono } from 'hono';
import { layout } from '../views/layout.js';
import type { PlatformChannel } from '@jonas/shared';

const app = new Hono();

const AGENT_URL = () => process.env.AGENT_API_URL ?? 'http://localhost:3001';

// --- Helper functions ---

function renderChannels(channels: PlatformChannel[]): string {
  if (channels.length === 0) {
    return '<p class="meta">No channels installed. Import a channel package to get started.</p>';
  }

  const rows = channels
    .map((ch) => renderChannelRow(ch))
    .join('');

  return `
    <table>
      <thead><tr><th>Channel</th><th>Platform</th><th>Mode</th><th>Status</th><th>State</th><th>Action</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderChannelRow(ch: PlatformChannel): string {
  const id = encodeURIComponent(ch.dirName);
  return `
    <tr>
      <td>
        <a href="/channels/${id}"><strong>${ch.metadata.name}</strong></a><br>
        <span class="meta">${ch.metadata.description || 'No description'}</span>
      </td>
      <td><code>${ch.metadata.platform}</code></td>
      <td>${ch.metadata.mode ? `<span class="badge badge--blue">${ch.metadata.mode}</span>` : '-'}</td>
      <td>
        <span class="badge ${ch.status === 'enabled' ? 'badge--green' : 'badge--red'}">${ch.status}</span>
      </td>
      <td>
        <span class="badge ${ch.state === 'running' ? 'badge--green' : ch.state === 'error' ? 'badge--red' : ''}">${ch.state}</span>
      </td>
      <td>
        <button
          class="btn btn--sm"
          hx-post="/channels/${id}/${ch.status === 'enabled' ? 'disable' : 'enable'}"
          hx-target="closest tr"
          hx-swap="outerHTML"
        >${ch.status === 'enabled' ? 'Disable' : 'Enable'}</button>
      </td>
    </tr>`;
}

function renderConfigSection(channel: PlatformChannel): string {
  const id = encodeURIComponent(channel.dirName);
  const allKeys = channel.secretKeys ?? [];
  const requiredSecrets = channel.config?.requiredSecrets ?? [];
  const optionalSecrets = channel.config?.optionalSecrets ?? [];
  const allConfigKeys = [...requiredSecrets, ...optionalSecrets];

  if (allConfigKeys.length === 0) {
    return '<p class="meta">This channel requires no configuration.</p>';
  }

  const configRows = allConfigKeys
    .map((key) => {
      const isRequired = requiredSecrets.includes(key);
      const isSet = allKeys.includes(key);
      const actionHtml = isSet
        ? `<button class="btn btn--sm btn--danger"
             hx-post="/channels/${id}/values/${encodeURIComponent(key)}/delete"
             hx-target="#config-section" hx-swap="innerHTML"
           >Remove</button>`
        : '';
      return `
        <tr>
          <td><code>${key}</code> ${isRequired ? '<span class="badge badge--red" style="font-size:0.7rem">required</span>' : '<span class="meta" style="font-size:0.7rem">optional</span>'}</td>
          <td><span class="badge ${isSet ? 'badge--green' : 'badge--red'}">${isSet ? 'set' : 'missing'}</span></td>
          <td>${actionHtml}</td>
        </tr>`;
    })
    .join('');

  let html = `
    <table>
      <thead><tr><th>Key</th><th>Status</th><th>Action</th></tr></thead>
      <tbody>${configRows}</tbody>
    </table>`;

  const unsetKeys = allConfigKeys.filter((k) => !allKeys.includes(k));
  const options = unsetKeys.map((k) => `<option value="${k}">${k}</option>`).join('');

  html += `
    <div style="margin-top:1rem">
      <form hx-post="/channels/${id}/values"
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

  return html;
}

function renderChannelDetail(channel: PlatformChannel): string {
  const id = encodeURIComponent(channel.dirName);
  const configJson = channel.config ? JSON.stringify(channel.config, null, 2) : '{}';

  return `
    <p><a href="/channels">&larr; Back to Channels</a></p>
    <h1>${channel.metadata.name}</h1>
    <p class="meta" style="margin-bottom:1.5rem">${channel.metadata.description || 'No description'}</p>

    <div class="card" style="margin-bottom:1.5rem">
      <dl style="display:grid;grid-template-columns:120px 1fr;gap:0.5rem">
        <dt class="meta">Platform:</dt><dd><code>${channel.metadata.platform}</code></dd>
        <dt class="meta">Version:</dt><dd>${channel.metadata.version}</dd>
        <dt class="meta">Author:</dt><dd>${channel.metadata.author}</dd>
        <dt class="meta">Mode:</dt><dd>${channel.metadata.mode || 'Not specified'}</dd>
        <dt class="meta">Status:</dt><dd><span class="badge ${channel.status === 'enabled' ? 'badge--green' : 'badge--red'}">${channel.status}</span></dd>
        <dt class="meta">State:</dt><dd><span class="badge ${channel.state === 'running' ? 'badge--green' : channel.state === 'error' ? 'badge--red' : ''}">${channel.state}</span></dd>
        ${channel.error ? `<dt class="meta">Error:</dt><dd class="badge badge--red">${channel.error}</dd>` : ''}
      </dl>
    </div>

    ${channel.state === 'running' ? `
      <div class="info-box" style="background:#065f4622;border-color:#065f46;margin-bottom:1.5rem">
        ✓ Channel is running and ready to receive messages
      </div>
    ` : channel.status === 'enabled' ? `
      <div class="info-box" style="background:#92400e22;border-color:#92400e;margin-bottom:1.5rem">
        Channel is enabled but not running. Click "Start" below to begin receiving messages.
      </div>
    ` : ''}

    <div class="card" style="margin-bottom:1.5rem">
      <h2>Actions</h2>
      <div style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-top:0.5rem">
        <button class="btn btn--sm ${channel.status === 'enabled' ? '' : 'btn--primary'}"
                hx-post="/channels/${id}/${channel.status === 'enabled' ? 'disable' : 'enable'}"
                hx-target="#status-indicator"
                hx-on::after-request="location.reload()">
          ${channel.status === 'enabled' ? 'Disable' : 'Enable'}
        </button>
        <button class="btn btn--sm ${channel.state === 'stopped' ? 'btn--primary' : ''}"
                hx-post="/channels/${id}/start"
                hx-target="#status-indicator"
                hx-on::after-request="location.reload()"
                ${channel.state === 'running' ? 'disabled' : ''}>
          Start
        </button>
        <button class="btn btn--sm"
                hx-post="/channels/${id}/stop"
                hx-target="#status-indicator"
                hx-on::after-request="location.reload()"
                ${channel.state !== 'running' ? 'disabled' : ''}>
          Stop
        </button>
        <a href="/channels/${id}/export" class="btn btn--sm">Export (.zip)</a>
        <button class="btn btn--sm btn--danger"
                hx-delete="/channels/${id}"
                hx-confirm="Delete this channel? This cannot be undone."
                hx-on::after-request="location.href='/channels'">
          Delete
        </button>
      </div>
      <div id="status-indicator"></div>
    </div>

    <div class="card" id="config-section">
      <h2>Configuration</h2>
      ${renderConfigSection(channel)}
    </div>

    <details style="margin-top:1.5rem">
      <summary class="meta" style="cursor:pointer">View config.json</summary>
      <pre style="margin-top:0.5rem;padding:0.75rem;background:#0d1117;border:1px solid #30363d;border-radius:6px;overflow-x:auto"><code>${configJson}</code></pre>
    </details>
  `;
}

// --- Routes ---

app.get('/channels', async (c) => {
  try {
    const res = await fetch(`${AGENT_URL()}/api/channels`);
    const data = (await res.json()) as PlatformChannel[];

    const importForm = `
      <div style="margin-bottom:1rem">
        <button class="btn btn--sm" onclick="document.getElementById('import-form').toggleAttribute('hidden')">
          Import Channel (.zip)
        </button>
      </div>
      <div id="import-form" hidden style="margin-bottom:1.5rem">
        <div class="card">
          <h3 style="margin-bottom:0.5rem">Import Channel from .zip</h3>
          <form action="/channels/import" method="post" enctype="multipart/form-data"
                style="display:flex;flex-direction:column;gap:0.5rem;max-width:500px">
            <input type="file" name="file" accept=".zip" required>
            <label style="display:flex;align-items:center;gap:0.5rem">
              <input type="checkbox" name="overwrite" value="true">
              <span class="meta">Overwrite if channel already exists</span>
            </label>
            <div style="display:flex;gap:0.5rem">
              <button type="submit" class="btn btn--sm">Import</button>
              <button type="button" class="btn btn--sm" onclick="document.getElementById('import-form').toggleAttribute('hidden')">Cancel</button>
            </div>
          </form>
        </div>
      </div>`;

    return c.html(layout('Channels', `<h1>Channels</h1>${importForm}${renderChannels(data)}`));
  } catch {
    return c.html(
      layout('Channels', '<h1>Channels</h1><p class="badge badge--red">Agent unreachable</p>'),
    );
  }
});

app.get('/channels/:name', async (c) => {
  const name = c.req.param('name');
  try {
    const res = await fetch(`${AGENT_URL()}/api/channels/${encodeURIComponent(name)}`);
    if (!res.ok) {
      return c.html(layout('Channel Not Found', '<h1>Channel Not Found</h1><p><a href="/channels">&larr; Back to Channels</a></p>'));
    }
    const channel = (await res.json()) as PlatformChannel;
    return c.html(layout(channel.metadata.name, renderChannelDetail(channel)));
  } catch {
    return c.html(
      layout('Error', '<h1>Error</h1><p class="badge badge--red">Agent unreachable</p>'),
    );
  }
});

// --- Actions ---

app.post('/channels/:name/enable', async (c) => {
  const name = c.req.param('name');
  await fetch(`${AGENT_URL()}/api/channels/${encodeURIComponent(name)}/enable`, { method: 'POST' });

  const res = await fetch(`${AGENT_URL()}/api/channels/${encodeURIComponent(name)}`);
  const channel = (await res.json()) as PlatformChannel;
  return c.html(renderChannelRow(channel));
});

app.post('/channels/:name/disable', async (c) => {
  const name = c.req.param('name');
  await fetch(`${AGENT_URL()}/api/channels/${encodeURIComponent(name)}/disable`, { method: 'POST' });

  const res = await fetch(`${AGENT_URL()}/api/channels/${encodeURIComponent(name)}`);
  const channel = (await res.json()) as PlatformChannel;
  return c.html(renderChannelRow(channel));
});

app.post('/channels/:name/start', async (c) => {
  const name = c.req.param('name');
  const res = await fetch(`${AGENT_URL()}/api/channels/${encodeURIComponent(name)}/start`, { method: 'POST' });

  if (!res.ok) {
    const error = await res.json();
    return c.html(`<div class="badge badge--red" style="margin-top:0.5rem">Failed to start: ${error.error}</div>`);
  }

  return c.html(`<div class="badge badge--green" style="margin-top:0.5rem">Channel started successfully</div>`);
});

app.post('/channels/:name/stop', async (c) => {
  const name = c.req.param('name');
  await fetch(`${AGENT_URL()}/api/channels/${encodeURIComponent(name)}/stop`, { method: 'POST' });
  return c.html(`<div class="badge badge--green" style="margin-top:0.5rem">Channel stopped successfully</div>`);
});

app.post('/channels/:name/values', async (c) => {
  const name = c.req.param('name');
  const body = await c.req.parseBody();

  const key = body.customKey || body.key;
  if (!key) {
    return c.html('<div class="badge badge--red">No key specified</div>');
  }

  await fetch(`${AGENT_URL()}/api/channels/${encodeURIComponent(name)}/values`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, value: body.value }),
  });

  const res = await fetch(`${AGENT_URL()}/api/channels/${encodeURIComponent(name)}`);
  const channel = (await res.json()) as PlatformChannel;
  return c.html(renderConfigSection(channel));
});

app.post('/channels/:name/values/:key/delete', async (c) => {
  const name = c.req.param('name');
  const key = c.req.param('key');

  await fetch(`${AGENT_URL()}/api/channels/${encodeURIComponent(name)}/values/${encodeURIComponent(key)}`, {
    method: 'DELETE',
  });

  const res = await fetch(`${AGENT_URL()}/api/channels/${encodeURIComponent(name)}`);
  const channel = (await res.json()) as PlatformChannel;
  return c.html(renderConfigSection(channel));
});

app.delete('/channels/:name', async (c) => {
  const name = c.req.param('name');
  await fetch(`${AGENT_URL()}/api/channels/${encodeURIComponent(name)}`, { method: 'DELETE' });
  return c.redirect('/channels');
});

app.get('/channels/:name/export', async (c) => {
  const name = c.req.param('name');
  const res = await fetch(`${AGENT_URL()}/api/channels/${encodeURIComponent(name)}/export`);

  if (!res.ok) {
    return c.text('Channel not found', 404);
  }

  const buffer = await res.arrayBuffer();
  const filename = `${name}.zip`;

  return new Response(buffer, {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
});

app.post('/channels/import', async (c) => {
  const body = await c.req.parseBody();
  const file = body.file;
  const overwrite = body.overwrite === 'true';

  if (!file || typeof file === 'string') {
    return c.html(layout('Import Failed', '<h1>Import Failed</h1><p class="badge badge--red">No file uploaded</p><p><a href="/channels">&larr; Back to Channels</a></p>'));
  }

  const formData = new FormData();
  formData.append('file', file);
  formData.append('overwrite', overwrite.toString());

  const res = await fetch(`${AGENT_URL()}/api/channels/import`, {
    method: 'POST',
    body: formData,
  });

  if (!res.ok) {
    const error = await res.json();
    return c.html(layout('Import Failed', `<h1>Import Failed</h1><p class="badge badge--red">${error.error}</p><p><a href="/channels">&larr; Back to Channels</a></p>`));
  }

  return c.redirect('/channels');
});

export default app;
