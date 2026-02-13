import { Hono } from 'hono';
import { layout } from '../views/layout.js';

const app = new Hono();

interface Task {
  id: string;
  name: string;
  cron: string;
  prompt: string;
  targetRoomId: string;
  status: string;
  enabled: boolean;
  lastRun?: string;
  nextRun?: string;
  lastResult?: string;
  createdAt: string;
}

function renderTasks(tasks: Task[]): string {
  if (tasks.length === 0) {
    return '<p class="meta">No scheduled tasks.</p>';
  }

  const rows = tasks
    .map(
      (t) => `
      <tr>
        <td><strong>${t.name}</strong></td>
        <td><code>${t.cron}</code></td>
        <td><span class="badge ${t.enabled ? 'badge--green' : 'badge--red'}">${t.enabled ? 'active' : 'paused'}</span></td>
        <td class="meta">${t.lastRun ? new Date(t.lastRun).toLocaleString() : '-'}</td>
        <td class="meta">${t.nextRun ? new Date(t.nextRun).toLocaleString() : '-'}</td>
      </tr>`
    )
    .join('');

  return `
    <table>
      <thead><tr><th>Task</th><th>Schedule</th><th>Status</th><th>Last Run</th><th>Next Run</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

app.get('/tasks', async (c) => {
  try {
    const agentUrl = process.env.AGENT_API_URL ?? 'http://localhost:3001';
    const res = await fetch(`${agentUrl}/api/tasks`);
    const data = (await res.json()) as Task[];
    return c.html(layout('Tasks', `<h1>Scheduled Tasks</h1>${renderTasks(data)}`));
  } catch {
    return c.html(
      layout('Tasks', '<h1>Scheduled Tasks</h1><p class="badge badge--red">Agent unreachable</p>')
    );
  }
});

export default app;
