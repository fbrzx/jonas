import { Hono } from 'hono';
import { layout } from '../views/layout.js';

const app = new Hono();

interface AuditEntry {
  id: string;
  timestamp: string;
  action: string;
  tool?: string;
  result?: string;
  channel: string;
  conversationId?: string;
}

function renderTable(entries: AuditEntry[]): string {
  if (entries.length === 0) {
    return '<p class="meta">No audit entries.</p>';
  }

  const rows = entries
    .map(
      (e) => `
      <tr>
        <td class="meta">${new Date(e.timestamp).toLocaleString()}</td>
        <td>${e.action}</td>
        <td>${e.channel}</td>
        <td>${e.tool ? `<code>${e.tool}</code>` : '-'}</td>
        <td>${e.result ? `<span class="badge ${e.result === 'success' ? 'badge--green' : 'badge--red'}">${e.result}</span>` : '-'}</td>
      </tr>`
    )
    .join('');

  return `
    <table>
      <thead>
        <tr><th>Timestamp</th><th>Action</th><th>Channel</th><th>Tool</th><th>Result</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

app.get('/audit', async (c) => {
  const isHtmx = c.req.header('HX-Request') === 'true';

  try {
    const agentUrl = process.env.AGENT_API_URL ?? 'http://localhost:3001';
    const res = await fetch(`${agentUrl}/api/audit`);
    const data = (await res.json()) as AuditEntry[];
    const tableHtml = renderTable(data);

    if (isHtmx) return c.html(tableHtml);

    return c.html(
      layout(
        'Audit',
        `<h1>Audit Log</h1>
        <div id="audit-content" hx-get="/audit" hx-trigger="every 10s" hx-swap="innerHTML">
          ${tableHtml}
        </div>`
      )
    );
  } catch {
    const errorHtml = '<p class="badge badge--red">Agent unreachable</p>';
    if (isHtmx) return c.html(errorHtml);
    return c.html(
      layout(
        'Audit',
        `<h1>Audit Log</h1>
        <div id="audit-content" hx-get="/audit" hx-trigger="every 10s" hx-swap="innerHTML">
          ${errorHtml}
        </div>`
      )
    );
  }
});

export default app;
