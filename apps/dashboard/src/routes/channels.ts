import { Hono } from 'hono';
import { layout } from '../views/layout.js';
import type { PlatformChannel } from '@jonas/shared/types';

const app = new Hono();

const AGENT_URL = () => process.env.AGENT_API_URL ?? 'http://localhost:3001';
const OAUTH_REDIRECT_URI = `${(process.env.OAUTH_REDIRECT_DOMAIN ?? 'http://localhost:3000').replace(/\/$/, '')}/oauth/callback`;

interface PairingStatus {
  required: boolean;
  paired: boolean;
  pairedAt?: string;
  challengeExpiresAt?: string;
}

interface OAuthFlowConfig {
  provider: string;
  scopes: string[];
}

function channelPairingType(name: string): string {
  return `channel:${name}`;
}

async function fetchChannel(name: string): Promise<PlatformChannel | null> {
  const res = await fetch(`${AGENT_URL()}/api/channels/${encodeURIComponent(name)}`);
  if (!res.ok) return null;
  return res.json() as Promise<PlatformChannel>;
}

async function fetchPairingStatus(name: string): Promise<PairingStatus | null> {
  const channelType = channelPairingType(name);
  const res = await fetch(`${AGENT_URL()}/api/pairing/status?channelType=${encodeURIComponent(channelType)}`);
  if (!res.ok) return null;
  return res.json() as Promise<PairingStatus>;
}

// --- Helper functions ---

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

function renderPairingSection(channel: PlatformChannel, pairing: PairingStatus | null, pairingMessage?: string): string {
  if (!pairing) {
    return '<p class="meta">Pairing status unavailable.</p>';
  }

  const pairingType = channelPairingType(channel.dirName);
  const statusBadge = pairing.paired
    ? '<span class="badge badge--green">paired</span>'
    : '<span class="badge badge--red">not paired</span>';

  return `
    <p class="meta">Pairing ID: <code>${pairingType}</code></p>
    <p style="margin-top:0.5rem">Status: ${statusBadge}</p>
    ${pairing.required ? '<p class="meta" style="margin-top:0.5rem">Pairing is required before this channel can deliver chat to the agent.</p>' : ''}
    ${pairing.pairedAt ? `<p class="meta" style="margin-top:0.5rem">Paired at: ${pairing.pairedAt}</p>` : ''}
    ${pairing.challengeExpiresAt ? `<p class="meta" style="margin-top:0.5rem">Current challenge expires at: ${pairing.challengeExpiresAt}</p>` : ''}
    ${pairingMessage ? `<p style="margin-top:0.75rem" class="badge badge--blue">${pairingMessage}</p>` : ''}

    <div style="margin-top:1rem;max-width:860px;display:flex;flex-direction:column;gap:0.75rem">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:0.75rem;flex-wrap:wrap">
        <form method="post" action="/channels/${encodeURIComponent(channel.dirName)}/pairing/init" style="margin:0">
          <button type="submit" class="btn btn--sm">Generate Pairing Code</button>
        </form>

        <form method="post" action="/channels/${encodeURIComponent(channel.dirName)}/pairing/revoke" style="margin:0">
          <button type="submit" class="btn btn--sm btn--danger">Revoke</button>
        </form>
      </div>

      <form method="post" action="/channels/${encodeURIComponent(channel.dirName)}/pairing/confirm" style="display:grid;grid-template-columns:minmax(220px,1fr) auto;gap:0.75rem;align-items:end">
        <div>
          <label class="meta" for="pairing-code">Code</label>
          <input id="pairing-code" name="code" type="text" placeholder="6-digit code" required style="max-width:none;width:100%">
        </div>
        <button type="submit" class="btn btn--sm">Confirm</button>
      </form>
    </div>
  `;
}

function renderChannelRequirements(channel: PlatformChannel): string {
  const id = encodeURIComponent(channel.dirName);
  const oauthEntries = Object.entries((channel.config?.oauth ?? {}) as Record<string, OAuthFlowConfig>);
  const allVaultKeys = channel.secretKeys ?? [];

  if (oauthEntries.length === 0) return '';

  let rows = '';

  for (const [key, flow] of oauthEntries) {
    const tokenStored = allVaultKeys.includes(key);
    const credsStored = allVaultKeys.includes(`__oauth_${key}_client_id`);

    let statusBadge: string;
    let actionHtml: string;

    if (tokenStored) {
      statusBadge = '<span class="badge badge--green">connected</span>';
      actionHtml = `
        <button class="btn btn--sm btn--danger"
          hx-post="/channels/${id}/requirements/${encodeURIComponent(key)}/disconnect"
          hx-target="#channel-requirements-section" hx-swap="innerHTML"
          hx-confirm="Disconnect ${flow.provider} from this channel?"
        >Disconnect</button>`;
    } else if (credsStored) {
      const connectParams = new URLSearchParams({
        provider: flow.provider,
        scopes: flow.scopes.join(','),
        entityType: 'channel',
      });
      statusBadge = '<span class="badge badge--yellow">ready to connect</span>';
      actionHtml = `
        <a href="/oauth/connect/${encodeURIComponent(channel.dirName)}/${encodeURIComponent(key)}?${connectParams.toString()}"
           class="btn btn--sm">Connect</a>`;
    } else {
      statusBadge = '<span class="badge badge--red">needs setup</span>';
      actionHtml = `
        <button class="btn btn--sm"
          onclick="this.closest('tr').nextElementSibling.toggleAttribute('hidden')"
        >Setup</button>`;
    }

    const setupPanel = !tokenStored && !credsStored ? `
      <tr class="setup-panel" hidden>
        <td colspan="4">
          <div class="card" style="margin:0.5rem 0">
            <p class="meta" style="margin-bottom:0.5rem">
              1. Go to the <strong>${flow.provider}</strong> developer console and create an OAuth app<br>
              2. Set redirect URI to: <code>${OAUTH_REDIRECT_URI}</code><br>
              3. Paste the credentials below
            </p>
            <form method="post" action="/channels/${id}/oauth-setup/${encodeURIComponent(key)}"
                  style="display:flex;flex-direction:column;gap:0.5rem;max-width:400px">
              <label class="meta">Client ID</label>
              <input type="text" name="clientId" required placeholder="your-client-id">
              <label class="meta">Client Secret</label>
              <input type="text" name="clientSecret" required placeholder="your-client-secret">
              <button type="submit" class="btn" style="align-self:flex-start">Save &amp; Connect</button>
            </form>
          </div>
        </td>
      </tr>` : '';

    rows += `
      <tr>
        <td><code>${key}</code></td>
        <td><span class="badge badge--blue">${flow.provider}</span></td>
        <td>${statusBadge}</td>
        <td>${actionHtml}</td>
      </tr>
      ${setupPanel}`;
  }

  return `
    <table>
      <thead><tr><th>Name</th><th>Type</th><th>Status</th><th>Action</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderChannelDetail(channel: PlatformChannel, pairing: PairingStatus | null, pairingMessage?: string): string {
  const id = encodeURIComponent(channel.dirName);
  const configJson = channel.config ? JSON.stringify(channel.config, null, 2) : '{}';
  const requirementsHtml = renderChannelRequirements(channel);
  const requirementsSection = requirementsHtml ? `
    <h2 style="margin-top:2rem">Requirements</h2>
    <div class="card" id="channel-requirements-section">
      ${requirementsHtml}
    </div>` : '';

  return `
    <p><a href="/ext">&larr; Back to Extensions</a></p>
    <h1>${channel.metadata.name}</h1>
    <p class="meta" style="margin-bottom:1.5rem">${channel.metadata.description}</p>

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

    ${requirementsSection}

    <div class="card" style="margin-top:1.5rem">
      <h2>Pairing</h2>
      ${renderPairingSection(channel, pairing, pairingMessage)}
    </div>

    <div style="margin-top:1.5rem">
      <button class="btn btn--sm" onclick="document.getElementById('config-editor').toggleAttribute('hidden')">
        Edit config.json
      </button>
    </div>
    <div id="config-editor" hidden style="margin-top:1rem">
      <div class="card">
        <h3 style="margin-bottom:0.5rem">Edit config.json</h3>
        <form hx-put="/channels/${id}/config"
              hx-target="#config-editor-result"
              style="display:flex;flex-direction:column;gap:0.5rem">
          <textarea name="config" rows="12" style="font-family:monospace;font-size:0.9em" required>${configJson}</textarea>
          <div style="display:flex;gap:0.5rem">
            <button type="submit" class="btn btn--sm">Save</button>
            <button type="button" class="btn btn--sm" onclick="document.getElementById('config-editor').toggleAttribute('hidden')">Cancel</button>
          </div>
        </form>
        <div id="config-editor-result"></div>
      </div>
    </div>
  `;
}

// --- Routes ---

app.get('/channels', (c) => c.redirect('/ext'));

app.get('/channels/:name', async (c) => {
  const name = c.req.param('name');
  const pairingMessage = c.req.query('pairingMessage') ?? '';
  try {
    const [channel, pairing] = await Promise.all([
      fetchChannel(name),
      fetchPairingStatus(name),
    ]);

    if (!channel) {
      return c.html(layout('Channel Not Found', '<h1>Channel Not Found</h1><p><a href="/ext">&larr; Back to Extensions</a></p>'));
    }
    return c.html(layout(channel.metadata.name, renderChannelDetail(channel, pairing, pairingMessage)));
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
    const error = (await res.json()) as { error?: string };
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

app.put('/channels/:name/config', async (c) => {
  const name = c.req.param('name');
  try {
    const body = await c.req.parseBody();
    const configText = body.config as string;
    if (!configText) return c.html('<p class="badge badge--red">Missing config</p>');

    let config;
    try {
      config = JSON.parse(configText);
    } catch {
      return c.html('<p class="badge badge--red">Invalid JSON. Please fix and try again.</p>');
    }

    const res = await fetch(`${AGENT_URL()}/api/channels/${encodeURIComponent(name)}/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });

    if (!res.ok) {
      const error = (await res.json()) as { error?: string };
      return c.html(`<p class="badge badge--red">${error.error ?? 'Failed to save'}</p>`);
    }

    return c.html('<p class="badge badge--green">Config saved. Reload to see changes.</p>');
  } catch {
    return c.html('<p class="badge badge--red">Agent unreachable</p>');
  }
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
    return c.html(layout('Import Failed', '<h1>Import Failed</h1><p class="badge badge--red">No file uploaded</p><p><a href="/ext">&larr; Back to Extensions</a></p>'));
  }

  const formData = new FormData();
  formData.append('file', file);
  formData.append('overwrite', overwrite.toString());

  const res = await fetch(`${AGENT_URL()}/api/channels/import`, {
    method: 'POST',
    body: formData,
  });

  if (!res.ok) {
    const error = (await res.json()) as { error?: string };
    return c.html(layout('Import Failed', `<h1>Import Failed</h1><p class="badge badge--red">${error.error}</p><p><a href="/ext">&larr; Back to Extensions</a></p>`));
  }

  return c.redirect('/channels');
});

// --- Channel OAuth setup (inline credentials form) ---

app.post('/channels/:name/oauth-setup/:key', async (c) => {
  const name = c.req.param('name');
  const key = c.req.param('key');
  try {
    const body = await c.req.parseBody();
    const clientId = body.clientId as string;
    const clientSecret = body.clientSecret as string;
    if (!clientId || !clientSecret) return c.text('Missing clientId or clientSecret', 400);

    await fetch(`${AGENT_URL()}/api/channels/${encodeURIComponent(name)}/oauth-provider/${encodeURIComponent(key)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, clientSecret }),
    });

    const res = await fetch(`${AGENT_URL()}/api/channels/${encodeURIComponent(name)}`);
    const channel = (await res.json()) as PlatformChannel;
    const oauth = (channel.config?.oauth as Record<string, OAuthFlowConfig> | undefined)?.[key];
    if (!oauth) return c.redirect(`/channels/${encodeURIComponent(name)}`);

    const connectParams = new URLSearchParams({
      provider: oauth.provider,
      scopes: oauth.scopes.join(','),
      entityType: 'channel',
    });
    return c.redirect(`/oauth/connect/${encodeURIComponent(name)}/${encodeURIComponent(key)}?${connectParams.toString()}`);
  } catch {
    return c.text('Agent unreachable', 502);
  }
});

// Disconnect OAuth token — returns updated requirements section HTML for HTMX
app.post('/channels/:name/requirements/:key/disconnect', async (c) => {
  const name = c.req.param('name');
  const key = c.req.param('key');
  try {
    await fetch(`${AGENT_URL()}/api/channels/${encodeURIComponent(name)}/values/${encodeURIComponent(key)}`, {
      method: 'DELETE',
    });
    const res = await fetch(`${AGENT_URL()}/api/channels/${encodeURIComponent(name)}`);
    const channel = (await res.json()) as PlatformChannel;
    return c.html(renderChannelRequirements(channel));
  } catch {
    return c.text('Agent unreachable', 502);
  }
});

app.post('/channels/:name/pairing/init', async (c) => {
  const name = c.req.param('name');
  const channelType = channelPairingType(name);

  try {
    const res = await fetch(`${AGENT_URL()}/api/pairing/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelType }),
    });
    const data = await res.json() as { code?: string; expiresAt?: string; error?: string };
    const message = res.ok && data.code
      ? `Pairing code: ${data.code} (expires ${data.expiresAt})`
      : (data.error ?? 'Failed to initialize pairing');
    return c.redirect(`/channels/${encodeURIComponent(name)}?pairingMessage=${encodeURIComponent(message)}`);
  } catch {
    return c.redirect(`/channels/${encodeURIComponent(name)}?pairingMessage=${encodeURIComponent('Agent unreachable')}`);
  }
});

app.post('/channels/:name/pairing/confirm', async (c) => {
  const name = c.req.param('name');
  const channelType = channelPairingType(name);
  const body = await c.req.parseBody();
  const code = String(body.code ?? '').trim();

  if (!code) {
    return c.redirect(`/channels/${encodeURIComponent(name)}?pairingMessage=${encodeURIComponent('Missing code')}`);
  }

  try {
    const res = await fetch(`${AGENT_URL()}/api/pairing/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelType, code }),
    });
    const data = await res.json() as { error?: string };
    const message = res.ok
      ? 'Pairing confirmed'
      : (data.error ?? 'Failed to confirm pairing');
    return c.redirect(`/channels/${encodeURIComponent(name)}?pairingMessage=${encodeURIComponent(message)}`);
  } catch {
    return c.redirect(`/channels/${encodeURIComponent(name)}?pairingMessage=${encodeURIComponent('Agent unreachable')}`);
  }
});

app.post('/channels/:name/pairing/revoke', async (c) => {
  const name = c.req.param('name');
  const channelType = channelPairingType(name);

  try {
    const res = await fetch(`${AGENT_URL()}/api/pairing/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelType }),
    });
    const data = await res.json() as { error?: string };
    const message = res.ok
      ? 'Pairing revoked'
      : (data.error ?? 'Failed to revoke pairing');
    return c.redirect(`/channels/${encodeURIComponent(name)}?pairingMessage=${encodeURIComponent(message)}`);
  } catch {
    return c.redirect(`/channels/${encodeURIComponent(name)}?pairingMessage=${encodeURIComponent('Agent unreachable')}`);
  }
});

export default app;
