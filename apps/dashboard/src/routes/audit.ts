import { Hono } from 'hono';
import { layout } from '../views/layout.js';

const app = new Hono();

const AGENT_URL = () => process.env.AGENT_API_URL ?? 'http://localhost:3001';

interface AuditEntry {
  id?: number;
  timestamp: string;
  action: string;
  details?: string;
  channelType?: string;
  channelId?: string;
  sessionKey?: string;
  model?: string;
  tokensUsed?: number;
  durationMs?: number;
  createdAt?: string;
}

interface AuditResponse {
  logs: AuditEntry[];
  total: number;
  limit: number;
  offset: number;
}

interface TaskSnapshot {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  enabled: boolean;
}

interface StatusSnapshot {
  activeConversations?: number;
}

function parseDetails(details?: string): Record<string, unknown> {
  if (!details) return {};
  try {
    return JSON.parse(details) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function summarizeDetails(action: string, details: Record<string, unknown>): string {
  if (typeof details.description === 'string' && details.description.trim()) {
    const description = details.description.replace(/\s+/g, ' ').trim();

    if (action === 'chat') {
      const userLen = typeof details.userMessageLength === 'number' ? details.userMessageLength : undefined;
      const responseLen = typeof details.responseLength === 'number' ? details.responseLength : undefined;
      const toolsUsed = Array.isArray(details.toolsUsed) ? details.toolsUsed.length : 0;
      const extras: string[] = [];
      if (typeof userLen === 'number') extras.push(`user ${userLen} chars`);
      if (typeof responseLen === 'number') extras.push(`assistant ${responseLen} chars`);
      if (toolsUsed > 0) extras.push(`${toolsUsed} tool${toolsUsed === 1 ? '' : 's'}`);
      if (extras.length > 0) {
        return `${description} (${extras.join(', ')})`;
      }
    }

    if (action === 'tool_use' || action === 'memory') {
      const tool = typeof details.tool === 'string' ? details.tool : undefined;
      const success = details.success === true ? 'success' : details.success === false ? 'failed' : undefined;
      const extras = [tool, success].filter(Boolean);
      if (extras.length > 0) {
        return `${description} (${extras.join(', ')})`;
      }
    }

    return description.length > 140 ? `${description.slice(0, 140)}...` : description;
  }

  if (action === 'chat' && typeof details.conversationId === 'string' && details.conversationId.trim()) {
    return 'Processed chat turn';
  }

  const candidateKeys = ['description', 'message', 'tool', 'toolName', 'error', 'conversationId', 'jobId'];
  for (const key of candidateKeys) {
    const value = details[key];
    if (typeof value === 'string' && value.trim()) {
      const clean = value.replace(/\s+/g, ' ').trim();
      return clean.length > 120 ? `${clean.slice(0, 120)}...` : clean;
    }
  }
  const keys = Object.keys(details);
  if (keys.length === 0) return '—';
  return keys.slice(0, 3).join(', ');
}

function sourceLabel(entry: AuditEntry): string {
  if (!entry.channelType || entry.channelType === 'dashboard') return 'Dashboard';
  if (entry.channelType === 'gateway') return `Gateway${entry.channelId ? ` (${entry.channelId})` : ''}`;
  return `${entry.channelType}${entry.channelId ? ` (${entry.channelId})` : ''}`;
}

function statusLabel(entry: AuditEntry, details: Record<string, unknown>): string {
  if (typeof details.error === 'string' && details.error) return '<span class="badge badge--red">failed</span>';
  if (entry.durationMs && entry.durationMs > 0) return '<span class="badge badge--green">completed</span>';
  return '<span class="badge badge--yellow">logged</span>';
}

function renderActivityNow(tasks: TaskSnapshot[], status: StatusSnapshot | null): string {
  const running = tasks.filter((task) => task.status === 'running');
  const pending = tasks.filter((task) => task.status === 'pending' && task.enabled);

  return `
    <div class="card" style="margin-bottom:1rem">
      <h2>Agent Activity (Now)</h2>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:0.75rem;margin-top:0.5rem">
        <div>
          <div class="meta">Active conversations</div>
          <strong>${status?.activeConversations ?? 0}</strong>
        </div>
        <div>
          <div class="meta">Running tasks</div>
          <strong>${running.length}</strong>
        </div>
        <div>
          <div class="meta">Pending tasks</div>
          <strong>${pending.length}</strong>
        </div>
      </div>
      <div style="margin-top:0.75rem">
        ${running.length === 0 && pending.length === 0
          ? '<span class="meta">No pending actions right now.</span>'
          : `
            <div class="meta" style="margin-bottom:0.25rem">Pending actions</div>
            ${[...running, ...pending].slice(0, 6).map((task) =>
              `<span class="badge ${task.status === 'running' ? 'badge--blue' : 'badge--yellow'}" style="margin-right:0.35rem;margin-bottom:0.35rem">${task.status}: ${task.name}</span>`).join('')}
          `}
      </div>
    </div>`;
}

function renderFilters(currentAction: string, currentFrom: string, currentTo: string): string {
  return `
    <style>
      .audit-filters {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
        gap: 0.75rem;
        align-items: end;
      }
      
      .audit-filter-group {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
      }
      
      .audit-filter-group label {
        font-size: 0.8rem;
      }
      
      .audit-filter-group select,
      .audit-filter-group input {
        width: 100%;
        max-width: none;
      }
      
      .audit-filter-actions {
        display: flex;
        gap: 0.5rem;
        align-items: center;
        justify-content: flex-start;
        flex-wrap: wrap;
      }
      
      @media (max-width: 600px) {
        .audit-filters {
          grid-template-columns: 1fr;
        }
        
        .audit-filter-actions {
          grid-column: 1;
        }
      }
    </style>
    <div class="card" style="margin-bottom:1rem">
      <form hx-get="/audit" hx-target="#audit-table" hx-swap="innerHTML" class="audit-filters">
        <div class="audit-filter-group">
          <label class="meta">Action</label>
          <select name="action">
            <option value="">All actions</option>
            <option value="chat" ${currentAction === 'chat' ? 'selected' : ''}>Chat</option>
            <option value="tool_use" ${currentAction === 'tool_use' ? 'selected' : ''}>Tool Use</option>
            <option value="memory" ${currentAction === 'memory' ? 'selected' : ''}>Memory</option>
            <option value="job" ${currentAction === 'job' ? 'selected' : ''}>Job</option>
          </select>
        </div>

        <div class="audit-filter-group">
          <label class="meta">From</label>
          <input type="datetime-local" name="from" value="${currentFrom}">
        </div>

        <div class="audit-filter-group">
          <label class="meta">To</label>
          <input type="datetime-local" name="to" value="${currentTo}">
        </div>

        <div class="audit-filter-actions">
          <button type="submit" class="btn btn--sm">Filter</button>
          <button type="button" class="btn btn--sm" onclick="window.location.href='/audit'">Clear</button>
        </div>
      </form>
      <p class="meta" style="margin-top:0.75rem">
        Actions: <strong>chat</strong> = conversation turn, <strong>tool_use</strong> = tool execution, <strong>memory</strong> = memory read/write, <strong>job</strong> = background jobs (queued, started, completed, failed, cancelled, interrupted).
      </p>
    </div>`;
}

function renderTable(response: AuditResponse | AuditEntry[]): string {
  // Handle legacy response format (array)
  const logs = Array.isArray(response) ? response : response.logs;
  const total = Array.isArray(response) ? response.length : response.total;
  const offset = Array.isArray(response) ? 0 : response.offset;
  const limit = Array.isArray(response) ? 100 : response.limit;

  if (logs.length === 0) {
    return '<p class="meta">No audit entries found.</p>';
  }

  const rows = logs.map((e) => {
    const details = parseDetails(e.details);
    const summary = summarizeDetails(e.action, details);
    const status = statusLabel(e, details);
    return `
      <tr>
        <td class="meta audit-col--timestamp">${new Date(e.timestamp).toLocaleString()}</td>
        <td class="audit-col--action"><span class="badge badge--blue">${e.action}</span></td>
        <td class="meta audit-col--source">${sourceLabel(e)}</td>
        <td class="meta audit-col--what">${summary}</td>
        <td class="audit-col--status">${status}</td>
        <td class="meta audit-col--model">${e.model || '-'}</td>
        <td class="meta audit-col--duration">${e.durationMs ? e.durationMs + 'ms' : '-'}</td>
      </tr>`;
  }).join('');

  const pagination = !Array.isArray(response) ? `
    <div class="audit-pagination">
      <p class="meta">Showing ${offset + 1}-${Math.min(offset + limit, total)} of ${total} entries</p>
      <div class="audit-pagination-buttons">
        ${offset > 0 ? `<button class="btn btn--sm" hx-get="/audit?offset=${Math.max(0, offset - limit)}&limit=${limit}" hx-target="#audit-table" hx-swap="innerHTML">Previous</button>` : ''}
        ${offset + limit < total ? `<button class="btn btn--sm" hx-get="/audit?offset=${offset + limit}&limit=${limit}" hx-target="#audit-table" hx-swap="innerHTML">Next</button>` : ''}
      </div>
    </div>` : '';

  return `
    <style>
      /* Table base styles */
      .audit-table {
        font-size: 0.85rem;
      }
      
      .audit-table .audit-col--timestamp { 
        min-width: 160px;
        font-size: 0.75rem;
      }
      .audit-table .audit-col--action { 
        min-width: 100px;
        white-space: nowrap;
      }
      .audit-table .audit-col--source { 
        min-width: 110px;
        font-size: 0.75rem;
      }
      .audit-table .audit-col--what { 
        min-width: 200px;
        font-size: 0.75rem;
      }
      .audit-table .audit-col--status { 
        min-width: 100px;
        white-space: nowrap;
      }
      .audit-table .audit-col--model { 
        min-width: 100px;
        font-size: 0.75rem;
      }
      .audit-table .audit-col--duration { 
        min-width: 80px;
        white-space: nowrap;
        font-size: 0.75rem;
      }
      
      /* Pagination styles */
      .audit-pagination {
        margin-top: 1rem;
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 1rem;
        flex-wrap: wrap;
      }
      
      .audit-pagination-buttons {
        display: flex;
        gap: 0.5rem;
      }
      
      /* Mobile responsive styles */
      @media (max-width: 768px) {
        .audit-table {
          font-size: 0.75rem;
        }
        
        .audit-table th,
        .audit-table td {
          padding: 0.5rem 0.35rem;
        }
        
        .audit-table .audit-col--timestamp { min-width: 140px; }
        .audit-table .audit-col--action { min-width: 90px; }
        .audit-table .audit-col--source { min-width: 100px; }
        .audit-table .audit-col--what { min-width: 180px; }
        .audit-table .audit-col--status { min-width: 90px; }
        .audit-table .audit-col--model { min-width: 80px; }
        .audit-table .audit-col--duration { min-width: 70px; }
        
        .audit-pagination {
          flex-direction: column;
          align-items: flex-start;
        }
        
        .audit-pagination-buttons {
          width: 100%;
          justify-content: space-between;
        }
      }
      
      @media (max-width: 480px) {
        .audit-table {
          font-size: 0.7rem;
        }
        
        .audit-table th,
        .audit-table td {
          padding: 0.4rem 0.25rem;
        }
        
        /* Hide less critical columns on very small screens */
        .audit-table .audit-col--model,
        .audit-table .audit-col--duration {
          display: none;
        }
        
        .audit-table .audit-col--timestamp { min-width: 120px; }
        .audit-table .audit-col--action { min-width: 80px; }
        .audit-table .audit-col--source { min-width: 90px; }
        .audit-table .audit-col--what { min-width: 150px; }
        .audit-table .audit-col--status { min-width: 80px; }
      }
    </style>
    <div class="table-scroll">
      <table class="audit-table">
        <thead>
          <tr>
            <th>Timestamp</th>
            <th>Action</th>
            <th>Source</th>
            <th>What</th>
            <th>Status</th>
            <th class="audit-col--model">Model</th>
            <th class="audit-col--duration">Duration</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${pagination}`;
}

app.get('/audit', async (c) => {
  const isHtmx = c.req.header('HX-Request') === 'true';
  const action = c.req.query('action') || '';
  const from = c.req.query('from') || '';
  const to = c.req.query('to') || '';
  const offset = c.req.query('offset') || '0';
  const limit = c.req.query('limit') || '100';

  try {
    const params = new URLSearchParams();
    if (action) params.set('action', action);
    if (from) params.set('from', new Date(from).toISOString());
    if (to) params.set('to', new Date(to).toISOString());
    params.set('offset', offset);
    params.set('limit', limit);

    const res = await fetch(`${AGENT_URL()}/api/audit?${params.toString()}`);
    const data = (await res.json()) as AuditResponse | AuditEntry[];
    const tableHtml = renderTable(data);

    let nowHtml = '';
    if (!isHtmx) {
      const [tasksRes, statusRes] = await Promise.all([
        fetch(`${AGENT_URL()}/api/tasks`),
        fetch(`${AGENT_URL()}/api/status`),
      ]);
      const tasks = tasksRes.ok ? (await tasksRes.json()) as TaskSnapshot[] : [];
      const status = statusRes.ok ? (await statusRes.json()) as StatusSnapshot : null;
      nowHtml = renderActivityNow(tasks, status);
    }

    if (isHtmx) return c.html(tableHtml);

    return c.html(
      layout(
        'Audit',
        `<h1>Audit Log</h1>
        ${nowHtml}
        ${renderFilters(action, from, to)}
        <div id="audit-table">
          ${tableHtml}
        </div>`
      )
    );
  } catch (err) {
    const errorHtml = '<p class="badge badge--red">Agent unreachable</p>';
    if (isHtmx) return c.html(errorHtml);
    return c.html(
      layout(
        'Audit',
        `<h1>Audit Log</h1>
        ${renderActivityNow([], null)}
        ${renderFilters(action, from, to)}
        <div id="audit-table">
          ${errorHtml}
        </div>`
      )
    );
  }
});

export default app;
