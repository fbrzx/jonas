import { Hono } from 'hono';
import AdmZip from 'adm-zip';
import type { Connection, PlatformChannel, Skill } from '@jonas/shared/types';
import { layout } from '../views/layout.js';

const app = new Hono();
const AGENT_URL = () => process.env.AGENT_API_URL ?? 'http://localhost:3001';
const PAGE_SIZE = 7;
type ExtensionType = 'skill' | 'channel';

type ConnectionsResponse = Connection[] | { skillConnections: Connection[]; connectionStatus: unknown[] };

interface ExtensionConnection {
  entityType: 'skill' | 'channel';
  entityId: string;
  entityName: string;
  secretKey: string;
  provider: string;
  connected: boolean;
  scopes: string[];
}

interface PaginationResult<T> {
  items: T[];
  page: number;
  totalPages: number;
  totalItems: number;
}

function redirectToExt(status: 'success' | 'error', message: string): Response {
  const params = new URLSearchParams({ importStatus: status, importMessage: message });
  return new Response(null, {
    status: 302,
    headers: { Location: `/ext?${params.toString()}` },
  });
}

function validateZipEntryName(entryName: string): void {
  if (!entryName || entryName.startsWith('/') || entryName.startsWith('\\')) {
    throw new Error('Invalid package: unsafe file path detected');
  }

  const normalized = entryName.replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '..')) {
    throw new Error('Invalid package: path traversal entry detected');
  }
}

function detectExtensionType(entries: AdmZip.IZipEntry[]): ExtensionType {
  const fileEntries = entries.filter((entry) => !entry.isDirectory);

  if (fileEntries.length === 0) {
    throw new Error('Invalid package: zip is empty');
  }

  for (const entry of fileEntries) {
    validateZipEntryName(entry.entryName);
  }

  const hasSkillMd = fileEntries.some((entry) => entry.entryName.endsWith('skill.md'));
  const hasChannelMdRoot = fileEntries.some((entry) => entry.entryName === 'channel.md');
  const hasChannelMdNested = fileEntries.some(
    (entry) => entry.entryName.endsWith('/channel.md') && entry.entryName !== 'channel.md',
  );

  if (hasSkillMd && (hasChannelMdRoot || hasChannelMdNested)) {
    throw new Error('Invalid package: contains both skill and channel manifests');
  }

  if (hasSkillMd) return 'skill';
  if (hasChannelMdRoot) return 'channel';
  if (hasChannelMdNested) {
    throw new Error('Invalid channel package: channel.md must be at zip root');
  }

  throw new Error('Invalid package: missing skill.md or channel.md');
}

function renderImportForm(importStatus: string | null, importMessage: string | null): string {
  const messageHtml = importMessage
    ? `<p class="badge ${importStatus === 'success' ? 'badge--green' : 'badge--red'}" style="margin-bottom:0.75rem">${importMessage}</p>`
    : '';

  return `
    <div class="card">
      <h2>Import Extension</h2>
      <p class="meta" style="margin-bottom:0.75rem">Upload one .zip package containing either a skill or a channel.</p>
      ${messageHtml}
      <form action="/ext/import" method="post" enctype="multipart/form-data" style="display:flex;flex-direction:column;gap:0.5rem;max-width:500px">
        <input type="file" name="file" accept=".zip" required>
        <label style="display:flex;align-items:center;gap:0.5rem">
          <input type="checkbox" name="overwrite" value="true">
          <span class="meta">Overwrite if extension already exists</span>
        </label>
        <button type="submit" class="btn btn--sm" style="align-self:flex-start">Import</button>
      </form>
    </div>`;
}

function parseConnections(raw: ConnectionsResponse): Connection[] {
  if (Array.isArray(raw)) return raw;
  return raw.skillConnections ?? [];
}

function parsePage(value: string | null): number {
  const parsed = Number.parseInt(value ?? '1', 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return parsed;
}

function paginate<T>(items: T[], requestedPage: number): PaginationResult<T> {
  const totalItems = items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));
  const page = Math.min(Math.max(requestedPage, 1), totalPages);
  const start = (page - 1) * PAGE_SIZE;
  return {
    items: items.slice(start, start + PAGE_SIZE),
    page,
    totalPages,
    totalItems,
  };
}

function pageLink(params: URLSearchParams, key: string, page: number): string {
  const next = new URLSearchParams(params);
  next.set(key, String(page));
  return `/ext?${next.toString()}`;
}

function renderPager(
  params: URLSearchParams,
  key: string,
  page: number,
  totalPages: number,
  totalItems: number,
): string {
  if (totalItems <= PAGE_SIZE) return '';

  const prev = page > 1
    ? `<a class="btn btn--sm" href="${pageLink(params, key, page - 1)}">Previous</a>`
    : '<span class="btn btn--sm" style="opacity:0.5;pointer-events:none">Previous</span>';

  const next = page < totalPages
    ? `<a class="btn btn--sm" href="${pageLink(params, key, page + 1)}">Next</a>`
    : '<span class="btn btn--sm" style="opacity:0.5;pointer-events:none">Next</span>';

  return `
    <div style="display:flex;align-items:center;gap:0.5rem;margin-top:0.75rem;flex-wrap:wrap">
      ${prev}
      <span class="meta">Page ${page} / ${totalPages} (${totalItems} total)</span>
      ${next}
    </div>`;
}

function renderSkillRow(skill: Skill): string {
  const id = encodeURIComponent(skill.dirName);
  return `
    <tr>
      <td><a href="/skills/${id}"><strong>${skill.metadata.name}</strong></a><br><span class="meta">${skill.metadata.description}</span></td>
      <td><span class="badge badge--blue">skill</span></td>
      <td>
        ${skill.hasPrompt ? '<span class="badge badge--blue">prompt</span> ' : ''}
        ${skill.hasTools ? '<span class="badge badge--blue">tools</span>' : ''}
      </td>
      <td><span class="badge ${skill.status === 'enabled' ? 'badge--green' : 'badge--red'}">${skill.status}</span></td>
      <td class="actions-col">
        <div class="table-actions">
          <button
            class="btn btn--sm"
            hx-post="/skills/${id}/${skill.status === 'enabled' ? 'disable' : 'enable'}"
            hx-target="closest tr"
            hx-swap="outerHTML"
          >${skill.status === 'enabled' ? 'Disable' : 'Enable'}</button>
          <a class="btn btn--sm" href="/ext/export/skill/${id}">Export</a>
        </div>
      </td>
    </tr>`;
}

function renderSkillsTable(skills: Skill[]): string {
  if (skills.length === 0) {
    return '<p class="meta">No skills found.</p>';
  }

  return `
    <table>
      <thead><tr><th>Skill</th><th>Type</th><th>Capabilities</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>${skills.map((skill) => renderSkillRow(skill)).join('')}</tbody>
    </table>`;
}

function renderChannelRow(channel: PlatformChannel): string {
  const id = encodeURIComponent(channel.dirName);
  return `
    <tr>
      <td>
        <a href="/channels/${id}"><strong>${channel.metadata.name}</strong></a><br>
        <span class="meta">${channel.metadata.description || 'No description'}</span>
      </td>
      <td><span class="badge badge--blue">channel</span></td>
      <td><code>${channel.metadata.platform}</code></td>
      <td>${channel.metadata.mode ? `<span class="badge badge--blue">${channel.metadata.mode}</span>` : '-'}</td>
      <td><span class="badge ${channel.status === 'enabled' ? 'badge--green' : 'badge--red'}">${channel.status}</span></td>
      <td><span class="badge ${channel.state === 'running' ? 'badge--green' : channel.state === 'error' ? 'badge--red' : ''}">${channel.state}</span></td>
      <td class="actions-col">
        <div class="table-actions">
          <button
            class="btn btn--sm"
            hx-post="/channels/${id}/${channel.status === 'enabled' ? 'disable' : 'enable'}"
            hx-target="closest tr"
            hx-swap="outerHTML"
          >${channel.status === 'enabled' ? 'Disable' : 'Enable'}</button>
          <a class="btn btn--sm" href="/ext/export/channel/${id}">Export</a>
        </div>
      </td>
    </tr>`;
}

function renderChannelsTable(channels: PlatformChannel[]): string {
  if (channels.length === 0) {
    return '<p class="meta">No channels found.</p>';
  }

  return `
    <table>
      <thead><tr><th>Channel</th><th>Type</th><th>Platform</th><th>Mode</th><th>Status</th><th>State</th><th>Actions</th></tr></thead>
      <tbody>${channels.map((channel) => renderChannelRow(channel)).join('')}</tbody>
    </table>`;
}

function renderConnectionsTable(connections: ExtensionConnection[]): string {
  if (connections.length === 0) {
    return '<p class="meta">No connections found.</p>';
  }

  const rows = connections
    .map((conn) => {
      const targetHref = conn.entityType === 'skill'
        ? `/skills/${encodeURIComponent(conn.entityId)}`
        : `/channels/${encodeURIComponent(conn.entityId)}`;

      return `
        <tr>
          <td><a href="${targetHref}">${conn.entityName}</a></td>
          <td><span class="badge badge--blue">${conn.entityType}</span></td>
          <td><code>${conn.provider}</code></td>
          <td><span class="badge ${conn.connected ? 'badge--green' : 'badge--red'}">${conn.connected ? 'connected' : 'not connected'}</span></td>
          <td class="actions-col"><div class="table-actions"><a class="btn btn--sm" href="${targetHref}">Manage</a><a class="btn btn--sm" href="/ext/export/${encodeURIComponent(conn.entityType)}/${encodeURIComponent(conn.entityId)}">Export</a></div></td>
        </tr>`;
    })
    .join('');

  return `
    <table>
      <thead><tr><th>Extension</th><th>Type</th><th>Provider</th><th>Status</th><th>Action</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function collectChannelConnections(channels: PlatformChannel[]): ExtensionConnection[] {
  const result: ExtensionConnection[] = [];

  for (const channel of channels) {
    const oauthConfig = channel.config?.oauth ?? {};
    const secretKeys = channel.secretKeys ?? [];

    for (const [key, flow] of Object.entries(oauthConfig)) {
      result.push({
        entityType: 'channel',
        entityId: channel.dirName,
        entityName: channel.metadata.name,
        secretKey: key,
        provider: flow.provider,
        connected: secretKeys.includes(key),
        scopes: flow.scopes,
      });
    }
  }

  return result;
}

app.get('/ext', async (c) => {
  try {
    const [skillsRes, channelsRes, connectionsRes] = await Promise.all([
      fetch(`${AGENT_URL()}/api/skills`),
      fetch(`${AGENT_URL()}/api/channels`),
      fetch(`${AGENT_URL()}/api/connections`),
    ]);

    const [skills, channels] = await Promise.all([
      skillsRes.json() as Promise<Skill[]>,
      channelsRes.json() as Promise<PlatformChannel[]>,
    ]);

    const skillConnections = connectionsRes.ok
      ? parseConnections((await connectionsRes.json()) as ConnectionsResponse)
      : [];

    const allConnections: ExtensionConnection[] = [
      ...skillConnections.map((conn) => ({
        entityType: 'skill' as const,
        entityId: conn.skillDirName,
        entityName: conn.skillName,
        secretKey: conn.secretKey,
        provider: conn.provider,
        connected: conn.connected,
        scopes: conn.scopes,
      })),
      ...collectChannelConnections(channels),
    ];

    const url = new URL(c.req.url);
    const searchParams = new URLSearchParams(url.searchParams);
    searchParams.delete('importStatus');
    searchParams.delete('importMessage');
    const importStatus = url.searchParams.get('importStatus');
    const importMessage = url.searchParams.get('importMessage');

    const pagedSkills = paginate(skills, parsePage(url.searchParams.get('skillsPage')));
    const pagedChannels = paginate(channels, parsePage(url.searchParams.get('channelsPage')));
    const pagedConnections = paginate(allConnections, parsePage(url.searchParams.get('connectionsPage')));

    return c.html(layout('Extensions', `
      <h1>Extensions</h1>

      ${renderImportForm(importStatus, importMessage)}

      <div class="card">
        <h2>Skills</h2>
        ${renderSkillsTable(pagedSkills.items)}
        ${renderPager(searchParams, 'skillsPage', pagedSkills.page, pagedSkills.totalPages, pagedSkills.totalItems)}
      </div>

      <div class="card">
        <h2>Channels</h2>
        ${renderChannelsTable(pagedChannels.items)}
        ${renderPager(searchParams, 'channelsPage', pagedChannels.page, pagedChannels.totalPages, pagedChannels.totalItems)}
      </div>

      <div class="card">
        <h2>Connections</h2>
        ${renderConnectionsTable(pagedConnections.items)}
        ${renderPager(searchParams, 'connectionsPage', pagedConnections.page, pagedConnections.totalPages, pagedConnections.totalItems)}
      </div>
    `));
  } catch {
    return c.html(layout('Extensions', '<h1>Extensions</h1><p class="badge badge--red">Agent unreachable</p>'));
  }
});

app.post('/ext/import', async (c) => {
  try {
    const body = await c.req.parseBody();
    const file = body.file;

    if (!file || typeof file === 'string') {
      return redirectToExt('error', 'No file uploaded');
    }

    if (!file.name.toLowerCase().endsWith('.zip')) {
      return redirectToExt('error', 'Invalid file type: only .zip is supported');
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    let zip: AdmZip;
    try {
      zip = new AdmZip(buffer);
    } catch {
      return redirectToExt('error', 'Invalid zip file');
    }

    const extensionType = detectExtensionType(zip.getEntries());
    const overwrite = body.overwrite === 'true';

    const formData = new FormData();
    formData.append('file', new Blob([buffer], { type: 'application/zip' }), file.name || `${extensionType}.zip`);
    formData.append('overwrite', overwrite ? 'true' : 'false');

    const importPath = extensionType === 'skill' ? '/api/skills/import' : '/api/channels/import';
    const response = await fetch(`${AGENT_URL()}${importPath}`, {
      method: 'POST',
      body: formData,
    });

    const payload = await response.json() as {
      error?: string;
      skill?: { dirName?: string };
      channel?: { dirName?: string };
    };

    if (!response.ok) {
      return redirectToExt('error', payload.error ?? `Failed to import ${extensionType}`);
    }

    const importedName = extensionType === 'skill'
      ? (payload.skill?.dirName ?? 'unknown')
      : (payload.channel?.dirName ?? 'unknown');

    return redirectToExt('success', `Imported ${extensionType}: ${importedName}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Import failed';
    return redirectToExt('error', message);
  }
});

app.get('/ext/export/:type/:id', async (c) => {
  const type = c.req.param('type');
  const id = c.req.param('id');

  if (type !== 'skill' && type !== 'channel') {
    return c.text('Invalid extension type', 400);
  }

  const exportPath = type === 'skill'
    ? `/api/skills/${encodeURIComponent(id)}/export`
    : `/api/channels/${encodeURIComponent(id)}/export`;

  const res = await fetch(`${AGENT_URL()}${exportPath}`);
  if (!res.ok) {
    return c.text('Export failed', res.status === 404 ? 404 : 502);
  }

  const zip = await res.arrayBuffer();
  const filename = `${type}-${id}.zip`;

  return new Response(zip, {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
});

export default app;