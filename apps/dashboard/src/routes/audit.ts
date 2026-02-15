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

function renderFilters(currentAction: string, currentFrom: string, currentTo: string): string {
  return `
    <div class="card" style="margin-bottom:1rem">
      <form hx-get="/audit" hx-target="#audit-table" hx-swap="innerHTML" style="display:flex;gap:0.5rem;flex-wrap:wrap;align-items:flex-end">
        <div class="form-group" style="margin:0">
          <label style="margin-bottom:0.25rem;font-size:0.85rem;display:block">Action</label>
          <select name="action" style="width:auto;min-width:150px">
            <option value="">All actions</option>
            <option value="chat" ${currentAction === 'chat' ? 'selected' : ''}>Chat</option>
            <option value="tool_use" ${currentAction === 'tool_use' ? 'selected' : ''}>Tool Use</option>
            <option value="memory" ${currentAction === 'memory' ? 'selected' : ''}>Memory</option>
          </select>
        </div>

        <div class="form-group" style="margin:0">
          <label style="margin-bottom:0.25rem;font-size:0.85rem;display:block">From</label>
          <input type="datetime-local" name="from" value="${currentFrom}" style="width:auto">
        </div>

        <div class="form-group" style="margin:0">
          <label style="margin-bottom:0.25rem;font-size:0.85rem;display:block">To</label>
          <input type="datetime-local" name="to" value="${currentTo}" style="width:auto">
        </div>

        <div style="margin:0;display:flex;gap:0.5rem;align-items:flex-end">
          <button type="submit" class="btn btn--sm">Filter</button>
          <button type="button" class="btn btn--sm" onclick="window.location.href='/audit'">Clear</button>
        </div>
      </form>
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
    const details = e.details ? JSON.parse(e.details) : {};
    return `
      <tr>
        <td class="meta" style="font-size:0.75rem">${new Date(e.timestamp).toLocaleString()}</td>
        <td><span class="badge badge--blue">${e.action}</span></td>
        <td>${e.channelType || '-'}</td>
        <td class="meta" style="font-size:0.75rem">${e.channelId || '-'}</td>
        <td class="meta" style="font-size:0.75rem">${details.conversationId?.slice(0, 8) || '-'}</td>
        <td class="meta" style="font-size:0.75rem">${e.model || '-'}</td>
        <td class="meta" style="font-size:0.75rem">${e.durationMs ? e.durationMs + 'ms' : '-'}</td>
      </tr>`;
  }).join('');

  const pagination = !Array.isArray(response) ? `
    <div style="margin-top:1rem;display:flex;justify-content:space-between;align-items:center">
      <p class="meta">Showing ${offset + 1}-${Math.min(offset + limit, total)} of ${total} entries</p>
      <div style="display:flex;gap:0.5rem">
        ${offset > 0 ? `<button class="btn btn--sm" hx-get="/audit?offset=${Math.max(0, offset - limit)}&limit=${limit}" hx-target="#audit-table" hx-swap="innerHTML">Previous</button>` : ''}
        ${offset + limit < total ? `<button class="btn btn--sm" hx-get="/audit?offset=${offset + limit}&limit=${limit}" hx-target="#audit-table" hx-swap="innerHTML">Next</button>` : ''}
      </div>
    </div>` : '';

  return `
    <table>
      <thead>
        <tr>
          <th>Timestamp</th>
          <th>Action</th>
          <th>Channel Type</th>
          <th>Channel ID</th>
          <th>Conversation</th>
          <th>Model</th>
          <th>Duration</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
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
    const data = await res.json();
    const tableHtml = renderTable(data);

    if (isHtmx) return c.html(tableHtml);

    return c.html(
      layout(
        'Audit',
        `<h1>Audit Log</h1>
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
        ${renderFilters(action, from, to)}
        <div id="audit-table">
          ${errorHtml}
        </div>`
      )
    );
  }
});

export default app;
