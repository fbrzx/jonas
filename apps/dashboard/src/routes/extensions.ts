import { Hono } from 'hono';
import AdmZip from 'adm-zip';
import type { PlatformChannel, Skill } from '@jonas/shared/types';
import { layout } from '../views/layout.js';

const app = new Hono();
const AGENT_URL = () => process.env.AGENT_API_URL ?? 'http://localhost:3001';
const PAGE_SIZE = 7;
type ExtensionType = 'skill' | 'channel';
type ExtFilterType = 'all' | ExtensionType;

interface PaginationResult<T> {
  items: T[];
  page: number;
  totalPages: number;
  totalItems: number;
}

interface UnifiedExtensionRow {
  type: ExtFilterType;
  name: string;
  details: string;
  status: string;
  actions: string;
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
      <style>
        .ext-import-file {
          width: 100%;
          max-width: 420px;
          background: #0d1117;
          border: 1px solid #30363d;
          border-radius: 8px;
          color: #c9d1d9;
          padding: 0.35rem;
          font-family: inherit;
          font-size: 0.875rem;
        }
        .ext-import-file::file-selector-button {
          border: none;
          border-radius: 6px;
          background: #1f6feb;
          color: #fff;
          font-family: inherit;
          font-size: 0.82rem;
          font-weight: 600;
          padding: 0.42rem 0.72rem;
          margin-right: 0.55rem;
          cursor: pointer;
        }
        .ext-import-file::file-selector-button:hover {
          background: #388bfd;
        }
      </style>
      <h2>Import Plugins</h2>
      <p class="meta" style="margin-bottom:0.75rem">Upload one .zip package containing either a skill or a channel.</p>
      ${messageHtml}
      <form action="/ext/import" method="post" enctype="multipart/form-data" style="display:flex;flex-direction:column;gap:0.5rem;max-width:500px">
        <input class="ext-import-file" type="file" name="file" accept=".zip" required>
        <label style="display:flex;align-items:center;gap:0.5rem">
          <input type="checkbox" name="overwrite" value="true">
          <span class="meta">Overwrite if plugin already exists</span>
        </label>
        <button type="submit" class="btn btn--sm" style="align-self:flex-start">Import</button>
      </form>
    </div>`;
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

function renderUnifiedExtensionsTable(rows: UnifiedExtensionRow[]): string {
  if (rows.length === 0) {
    return '<p class="meta">No matching plugins found.</p>';
  }

  return `
    <style>
      .ext-table .ext-col--name { min-width: 220px; }
      .ext-table .ext-col--type { min-width: 130px; white-space: nowrap; }
      .ext-table .ext-col--details { min-width: 280px; }
      .ext-table .ext-col--status { min-width: 170px; white-space: nowrap; }
      .ext-table .ext-col--actions { min-width: 180px; white-space: nowrap; }
      @media (max-width: 900px) {
        .ext-table .ext-col--name { min-width: 250px; }
        .ext-table .ext-col--details { min-width: 320px; }
      }
    </style>
    <div class="table-scroll">
      <table class="ext-table">
        <thead><tr><th>Name</th><th>Type</th><th>Details</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>
          ${rows.map((row) => `
            <tr>
              <td class="ext-col--name">${row.name}</td>
              <td class="ext-col--type"><span class="badge badge--blue">${row.type}</span></td>
              <td class="ext-col--details">${row.details}</td>
              <td class="ext-col--status">${row.status}</td>
              <td class="ext-col--actions actions-col"><div class="table-actions">${row.actions}</div></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>`;
}

function parseExtFilter(value: string | null): ExtFilterType {
  if (value === 'skill' || value === 'channel') return value;
  return 'all';
}

function renderTypeFilter(current: ExtFilterType, params: URLSearchParams): string {
  const options: { value: ExtFilterType; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'skill', label: 'Skills' },
    { value: 'channel', label: 'Channels' },
  ];

  const links = options.map(({ value, label }) => {
    const next = new URLSearchParams(params);
    next.set('extType', value);
    next.set('page', '1');
    const cls = value === current ? 'btn btn--sm btn--primary' : 'btn btn--sm';
    return `<a class="${cls}" href="/ext?${next.toString()}" style="text-decoration:none">${label}</a>`;
  }).join('');

  return `
    <div class="card" style="margin-bottom:1rem">
      <div style="display:grid;grid-template-columns:auto 1fr;gap:0.5rem 0.75rem;align-items:start">
        <span class="meta" style="padding-top:0.3rem">Type:</span>
        <div style="display:flex;gap:0.5rem;flex-wrap:wrap;align-items:center">
          ${links}
        </div>
      </div>
    </div>`;
}

app.get('/ext', async (c) => {
  try {
    const [skillsRes, channelsRes] = await Promise.all([
      fetch(`${AGENT_URL()}/api/skills`),
      fetch(`${AGENT_URL()}/api/channels`),
    ]);

    const [skills, channels] = await Promise.all([
      skillsRes.json() as Promise<Skill[]>,
      channelsRes.json() as Promise<PlatformChannel[]>,
    ]);

    const url = new URL(c.req.url);
    const searchParams = new URLSearchParams(url.searchParams);
    searchParams.delete('importStatus');
    searchParams.delete('importMessage');
    const importStatus = url.searchParams.get('importStatus');
    const importMessage = url.searchParams.get('importMessage');
    const extType = parseExtFilter(url.searchParams.get('extType'));

    const skillRows: UnifiedExtensionRow[] = skills.map((skill) => {
      const id = encodeURIComponent(skill.dirName);
      const details = `${skill.metadata.description}<br><span class="meta">${skill.hasPrompt ? 'prompt ' : ''}${skill.hasTools ? 'tools' : ''}</span>`;
      const status = `<span class="badge ${skill.status === 'enabled' ? 'badge--green' : 'badge--red'}">${skill.status}</span>`;
      const actions = `
        <button class="btn btn--sm"
          hx-post="/skills/${id}/${skill.status === 'enabled' ? 'disable' : 'enable'}"
          hx-swap="none"
          hx-on::after-request="location.reload()"
        >${skill.status === 'enabled' ? 'Disable' : 'Enable'}</button>
        <a class="btn btn--sm" href="/skills/${id}">Manage</a>
        <a class="btn btn--sm" href="/ext/export/skill/${id}">Export</a>`;

      return {
        type: 'skill',
        name: `<a href="/skills/${id}"><strong>${skill.metadata.name}</strong></a>`,
        details,
        status,
        actions,
      };
    });

    const channelRows: UnifiedExtensionRow[] = channels.map((channel) => {
      const id = encodeURIComponent(channel.dirName);
      const details = `<code>${channel.metadata.platform}</code>${channel.metadata.mode ? ` <span class="badge badge--blue">${channel.metadata.mode}</span>` : ''}`;
      const status = `
        <span class="badge ${channel.status === 'enabled' ? 'badge--green' : 'badge--red'}">${channel.status}</span>
        <span class="badge ${channel.state === 'running' ? 'badge--green' : channel.state === 'error' ? 'badge--red' : ''}">${channel.state}</span>`;
      const actions = `
        <button class="btn btn--sm"
          hx-post="/channels/${id}/${channel.status === 'enabled' ? 'disable' : 'enable'}"
          hx-swap="none"
          hx-on::after-request="location.reload()"
        >${channel.status === 'enabled' ? 'Disable' : 'Enable'}</button>
        <a class="btn btn--sm" href="/channels/${id}">Manage</a>
        <a class="btn btn--sm" href="/ext/export/channel/${id}">Export</a>`;

      return {
        type: 'channel',
        name: `<a href="/channels/${id}"><strong>${channel.metadata.name}</strong></a><br><span class="meta">${channel.metadata.description || ''}</span>`,
        details,
        status,
        actions,
      };
    });

    const unifiedRows = [...skillRows, ...channelRows];
    const filteredRows = extType === 'all' ? unifiedRows : unifiedRows.filter((row) => row.type === extType);
    const pagedRows = paginate(filteredRows, parsePage(url.searchParams.get('page')));

    return c.html(layout('Plugins', `
      <h1>Plugins</h1>

      ${renderTypeFilter(extType, searchParams)}

      <div class="card">
        ${renderUnifiedExtensionsTable(pagedRows.items)}
        ${renderPager(searchParams, 'page', pagedRows.page, pagedRows.totalPages, pagedRows.totalItems)}
      </div>

      ${renderImportForm(importStatus, importMessage)}

    `));
  } catch {
    return c.html(layout('Plugins', '<h1>Plugins</h1><p class="badge badge--red">Agent unreachable</p>'));
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