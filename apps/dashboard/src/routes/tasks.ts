import { Hono } from 'hono';
import { layout } from '../views/layout.js';

const app = new Hono();

const AGENT_URL = () => process.env.AGENT_API_URL ?? 'http://localhost:3001';

interface Task {
  id: string;
  name: string;
  cron: string;
  prompt: string;
  targetChannelType?: string;
  targetChannelId?: string;
  enabled: boolean;
  nextRun?: string;
  lastRun?: string;
  runCount?: number;
  status: 'pending' | 'running' | 'completed' | 'failed';
  lastResult?: string;
}

function escAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function parseCronDescription(cron: string): string {
  const patterns: Record<string, string> = {
    '0 8 * * *': 'Every day at 8:00 AM',
    '0 9 * * 1': 'Every Monday at 9:00 AM',
    '0 0 * * *': 'Daily at midnight',
    '*/15 * * * *': 'Every 15 minutes',
    '0 */1 * * *': 'Every hour',
    '0 12 * * *': 'Every day at noon',
  };
  return patterns[cron] || `Cron: ${cron}`;
}

function formatResult(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return raw;
  }
}

function renderTaskRow(task: Task): string {
  const nextRun = task.nextRun ? new Date(task.nextRun).toLocaleString() : 'Not scheduled';
  const lastRun = task.lastRun ? new Date(task.lastRun).toLocaleString() : 'Never';
  const cronDesc = parseCronDescription(task.cron);
  const effectiveStatus = !task.enabled && task.status === 'running' ? 'pending' : task.status;

  const statusBadge = {
    pending: '<span class="badge">⏳ Pending</span>',
    running: '<span class="badge badge--blue">▶️ Running</span>',
    completed: '<span class="badge badge--green">✓ Success</span>',
    failed: '<span class="badge badge--red">✗ Failed</span>',
  }[effectiveStatus] || '<span class="badge">Unknown</span>';

  return `
    <tr id="task-${task.id}">
      <td class="tasks-col--task">
        <strong>${task.name}</strong><br>
        <span class="meta">${task.prompt.slice(0, 80)}${task.prompt.length > 80 ? '...' : ''}</span>
      </td>
      <td class="meta tasks-col--schedule" style="font-size:0.8rem">
        ${cronDesc}<br>
        <code style="font-size:0.7rem">${task.cron}</code>
      </td>
      <td class="meta tasks-col--runs" style="font-size:0.75rem">
        <strong>Next:</strong> ${nextRun}<br>
        <strong>Last:</strong> ${lastRun}
      </td>
      <td class="meta tasks-col--target" style="font-size:0.75rem">${task.targetChannelType || 'dashboard'}</td>
      <td class="tasks-col--status" style="white-space:nowrap">
        <span class="badge ${task.enabled ? 'badge--green' : 'badge--red'}">
          ${task.enabled ? '● Active' : '○ Paused'}
        </span>
        <div style="margin-top:0.25rem">${statusBadge}</div>
        ${task.lastResult ? `<button class="btn btn--sm" style="margin-top:0.25rem;font-size:0.65rem;padding:0.15rem 0.4rem" onclick="document.getElementById('result-${task.id}').toggleAttribute('hidden')">Last result</button>` : ''}
      </td>
      <td class="tasks-col--actions" style="white-space:nowrap">
        <div style="display:flex;gap:0.25rem">
          <button class="btn btn--sm" onclick="toggleEditForm('edit-${task.id}')">Edit</button>
          <button class="btn btn--sm"
            hx-post="/tasks/${task.id}/run"
            hx-swap="none"
            hx-on::after-request="window.jonasAck(event.detail.xhr.responseText || 'Task queued for execution')">
            Run Now
          </button>
        </div>
        <div style="display:flex;gap:0.25rem;margin-top:0.25rem">
          ${task.enabled
            ? `<button class="btn btn--sm" hx-post="/tasks/${task.id}/pause" hx-target="#task-${task.id}" hx-swap="outerHTML">Pause</button>`
            : `<button class="btn btn--sm btn--primary" hx-post="/tasks/${task.id}/resume" hx-target="#task-${task.id}" hx-swap="outerHTML">Resume</button>`
          }
          <button class="btn btn--sm btn--danger"
            hx-delete="/tasks/${task.id}"
            hx-confirm="Delete task '${task.name}'?"
            hx-target="#task-${task.id}"
            hx-swap="delete">
            Delete
          </button>
        </div>
      </td>
    </tr>
    <tr id="edit-${task.id}" class="edit-row" hidden>
      <td colspan="6">
        <div class="card" style="margin:0.5rem 0">
          <h3 style="margin-bottom:0.5rem">Edit Task</h3>
          <form id="form-edit-${task.id}"
                data-original-name="${escAttr(task.name)}"
                data-original-cron="${escAttr(task.cron)}"
                data-original-prompt="${escAttr(task.prompt)}"
                data-original-targetchanneltype="${escAttr(task.targetChannelType || 'dashboard')}"
                hx-put="/tasks/${task.id}"
                hx-target="#task-${task.id}"
                hx-swap="outerHTML"
                onsubmit="markTaskFormDirty(this)"
                hx-on::after-request="handleTaskEditDone('edit-${task.id}', this, event)"
                style="display:flex;flex-direction:column;gap:0.75rem;max-width:600px">
            <div>
              <label class="meta" style="display:block;margin-bottom:0.25rem">Task Name</label>
              <input type="text" name="name" value="${task.name}" required style="width:100%;max-width:none">
            </div>
            <div>
              <label class="meta" style="display:block;margin-bottom:0.25rem">Cron Schedule</label>
              <input type="text" name="cron" value="${task.cron}" required style="width:100%;max-width:none"
                oninput="document.getElementById('cron-preview-${task.id}').textContent = parseCronDesc(this.value)">
              <div id="cron-preview-${task.id}" class="meta" style="margin-top:0.25rem">${cronDesc}</div>
              <div class="meta" style="margin-top:0.25rem;font-size:0.7rem">
                Examples: <code>0 8 * * *</code> (daily 8am), <code>0 9 * * 1</code> (Mon 9am), <code>*/15 * * * *</code> (every 15min)
              </div>
            </div>
            <div>
              <label class="meta" style="display:block;margin-bottom:0.25rem">Prompt</label>
              <textarea name="prompt" rows="4" required style="width:100%;max-width:none">${task.prompt}</textarea>
            </div>
            <div>
              <label class="meta" style="display:block;margin-bottom:0.25rem">Target Channel</label>
              <input type="text" name="targetChannelType" value="${task.targetChannelType || 'dashboard'}" style="width:100%;max-width:none">
              <div class="meta" style="margin-top:0.25rem;font-size:0.7rem">Channel type (e.g., dashboard, matrix, telegram)</div>
            </div>
            <div style="display:flex;gap:0.5rem">
              <button type="submit" class="btn btn--sm">Save Changes</button>
              <button type="button" class="btn btn--sm" onclick="cancelTaskEdit('edit-${task.id}', document.getElementById('form-edit-${task.id}'))">Cancel</button>
            </div>
          </form>
        </div>
      </td>
    </tr>
    ${task.lastResult ? `
    <tr id="result-${task.id}" hidden>
      <td colspan="6">
        <div class="card" style="margin:0.5rem 0">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem">
            <span class="meta">Last result</span>
            <button class="btn btn--sm" style="font-size:0.65rem;padding:0.15rem 0.4rem" onclick="document.getElementById('result-${task.id}').toggleAttribute('hidden')">Close</button>
          </div>
          <pre style="font-size:0.8rem;padding:0.75rem;background:#0d1117;border:1px solid #30363d;border-radius:6px;overflow-x:auto;max-height:400px;overflow-y:auto;white-space:pre-wrap;word-break:break-word"><code>${formatResult(task.lastResult)}</code></pre>
        </div>
      </td>
    </tr>` : ''}`;
}

function renderTasksList(tasks: Task[]): string {
  if (tasks.length === 0) {
    return '<p class="meta">No scheduled tasks. Create one to get started.</p>';
  }
  return `
    <style>
      .tasks-table .tasks-col--task { min-width: 220px; }
      .tasks-table .tasks-col--schedule { min-width: 180px; }
      .tasks-table .tasks-col--runs { min-width: 190px; }
      .tasks-table .tasks-col--target { min-width: 120px; }
      .tasks-table .tasks-col--status { min-width: 150px; }
      .tasks-table .tasks-col--actions { min-width: 180px; }
      @media (max-width: 900px) {
        .tasks-table .tasks-col--task { min-width: 260px; }
      }
    </style>
    <div class="table-scroll">
      <table class="tasks-table">
        <thead>
          <tr><th>Task</th><th>Schedule</th><th>Runs</th><th>Target</th><th>Status</th><th>Actions</th></tr>
        </thead>
        <tbody>${tasks.map(renderTaskRow).join('')}</tbody>
      </table>
    </div>`;
}

export default app;

app.get('/tasks', async (c) => {
  try {
    const res = await fetch(`${AGENT_URL()}/api/tasks`);
    const tasks = (await res.json()) as Task[];

    const createForm = `
      <div class="card" style="margin-bottom:1rem">
        <button class="btn btn--sm" onclick="toggleEditForm('create-task-form')">+ New Task</button>
        <div id="create-task-form" hidden style="margin-top:1rem">
          <h3 style="margin-bottom:0.75rem">Create New Task</h3>
          <form hx-post="/tasks/create"
                hx-target="#tasks-list"
                hx-swap="innerHTML"
                hx-on::after-request="document.getElementById('create-task-form').setAttribute('hidden', ''); window.jonasAck('Task created')"
                style="display:flex;flex-direction:column;gap:0.75rem;max-width:600px">
            <div>
              <label class="meta" style="display:block;margin-bottom:0.25rem">Task Name</label>
              <input type="text" name="name" placeholder="Daily morning briefing" required style="width:100%;max-width:none">
            </div>
            <div>
              <label class="meta" style="display:block;margin-bottom:0.25rem">Cron Schedule</label>
              <input type="text" name="cron" placeholder="0 8 * * *" required style="width:100%;max-width:none"
                oninput="document.getElementById('cron-preview-create').textContent = parseCronDesc(this.value)">
              <div id="cron-preview-create" class="meta" style="margin-top:0.25rem"></div>
              <div class="meta" style="margin-top:0.25rem;font-size:0.7rem">
                Examples: <code>0 8 * * *</code> (daily 8am), <code>0 9 * * 1</code> (Mon 9am), <code>*/15 * * * *</code> (every 15min)
              </div>
            </div>
            <div>
              <label class="meta" style="display:block;margin-bottom:0.25rem">Prompt</label>
              <textarea name="prompt" rows="4" placeholder="Summarize my emails and provide a morning briefing" required style="width:100%;max-width:none"></textarea>
            </div>
            <div>
              <label class="meta" style="display:block;margin-bottom:0.25rem">Target Channel (optional)</label>
              <input type="text" name="targetChannelType" placeholder="dashboard" value="dashboard" style="width:100%;max-width:none">
              <div class="meta" style="margin-top:0.25rem;font-size:0.7rem">Channel type (e.g., dashboard, matrix, telegram)</div>
            </div>
            <div style="display:flex;gap:0.5rem">
              <button type="submit" class="btn">Create Task</button>
              <button type="button" class="btn btn--sm" onclick="toggleEditForm('create-task-form')">Cancel</button>
            </div>
          </form>
        </div>
      </div>`;

    const script = `
      <script>
        function toggleEditForm(id) {
          var el = document.getElementById(id);
          if (el) {
            if (el.hasAttribute('hidden')) {
              el.removeAttribute('hidden');
            } else {
              el.setAttribute('hidden', '');
            }
          }
        }

        function taskFormHasChanges(form) {
          if (!form) return false;
          var originalName = form.dataset.originalName || '';
          var originalCron = form.dataset.originalCron || '';
          var originalPrompt = form.dataset.originalPrompt || '';
          var originalTarget = form.dataset.originalTargetchanneltype || '';
          var currentName = (form.querySelector('[name="name"]') || {}).value || '';
          var currentCron = (form.querySelector('[name="cron"]') || {}).value || '';
          var currentPrompt = (form.querySelector('[name="prompt"]') || {}).value || '';
          var currentTarget = (form.querySelector('[name="targetChannelType"]') || {}).value || '';
          return currentName !== originalName
            || currentCron !== originalCron
            || currentPrompt !== originalPrompt
            || currentTarget !== originalTarget;
        }

        function markTaskFormDirty(form) {
          form.dataset.changed = taskFormHasChanges(form) ? '1' : '0';
        }

        function handleTaskEditDone(editRowId, form, evt) {
          var editRow = document.getElementById(editRowId);
          if (editRow) editRow.setAttribute('hidden', '');
          if (evt && evt.detail && evt.detail.successful && form && form.dataset.changed === '1') {
            window.jonasAck('Task changes saved');
          }
        }

        function cancelTaskEdit(editRowId, form) {
          var changed = taskFormHasChanges(form);
          var editRow = document.getElementById(editRowId);
          if (editRow) editRow.setAttribute('hidden', '');
          if (changed) {
            window.jonasAck('Changes discarded');
          }
        }

        function parseCronDesc(cron) {
          var patterns = {
            '0 8 * * *': 'Every day at 8:00 AM',
            '0 9 * * 1': 'Every Monday at 9:00 AM',
            '0 0 * * *': 'Daily at midnight',
            '*/15 * * * *': 'Every 15 minutes',
            '0 */1 * * *': 'Every hour',
            '0 12 * * *': 'Every day at noon',
            '0 9 * * *': 'Every day at 9:00 AM',
            '0 17 * * *': 'Every day at 5:00 PM',
            '0 0 * * 0': 'Every Sunday at midnight',
            '30 8 * * 1-5': 'Weekdays at 8:30 AM'
          };
          return patterns[cron] || 'Cron: ' + cron;
        }
      </script>`;

    const content = `<h1>Scheduled Tasks</h1>
      ${createForm}
      <div id="tasks-list">${renderTasksList(tasks)}</div>
      ${script}`;

    return c.html(layout('Tasks', content));
  } catch {
    return c.html(layout('Tasks', '<h1>Scheduled Tasks</h1><p class="badge badge--red">Agent unreachable</p>'));
  }
});

app.post('/tasks/:id/pause', async (c) => {
  const id = c.req.param('id');
  try {
    await fetch(`${AGENT_URL()}/api/tasks/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    const res = await fetch(`${AGENT_URL()}/api/tasks`);
    const tasks = (await res.json()) as Task[];
    const task = tasks.find(t => t.id === id);
    if (!task) return c.body(null, 204);
    return c.html(renderTaskRow(task));
  } catch {
    return c.text('Error pausing task', 500);
  }
});

app.post('/tasks/:id/resume', async (c) => {
  const id = c.req.param('id');
  try {
    await fetch(`${AGENT_URL()}/api/tasks/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    const res = await fetch(`${AGENT_URL()}/api/tasks`);
    const tasks = (await res.json()) as Task[];
    const task = tasks.find(t => t.id === id);
    if (!task) return c.body(null, 204);
    return c.html(renderTaskRow(task));
  } catch {
    return c.text('Error resuming task', 500);
  }
});

app.delete('/tasks/:id', async (c) => {
  const id = c.req.param('id');
  try {
    await fetch(`${AGENT_URL()}/api/tasks/${id}`, { method: 'DELETE' });
    return c.text('', 200);
  } catch {
    return c.text('Error deleting task', 500);
  }
});

app.post('/tasks/create', async (c) => {
  try {
    const body = await c.req.parseBody();
    const taskData = {
      name: String(body.name ?? ''),
      cron: String(body.cron ?? ''),
      prompt: String(body.prompt ?? ''),
      targetChannelType: String(body.targetChannelType ?? 'dashboard'),
      enabled: true,
    };

    await fetch(`${AGENT_URL()}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(taskData),
    });

    // Reload and render all tasks
    const res = await fetch(`${AGENT_URL()}/api/tasks`);
    const tasks = (await res.json()) as Task[];
    return c.html(renderTasksList(tasks));
  } catch {
    return c.text('Error creating task', 500);
  }
});

app.put('/tasks/:id', async (c) => {
  const id = c.req.param('id');
  try {
    const body = await c.req.parseBody();
    const updateData = {
      name: String(body.name ?? ''),
      cron: String(body.cron ?? ''),
      prompt: String(body.prompt ?? ''),
      targetChannelType: String(body.targetChannelType ?? 'dashboard'),
    };

    await fetch(`${AGENT_URL()}/api/tasks/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updateData),
    });

    // Fetch updated task and render row
    const res = await fetch(`${AGENT_URL()}/api/tasks`);
    const tasks = (await res.json()) as Task[];
    const task = tasks.find(t => t.id === id);
    if (!task) return c.body(null, 204);
    return c.html(renderTaskRow(task));
  } catch {
    return c.text('Error updating task', 500);
  }
});

app.post('/tasks/:id/run', async (c) => {
  const id = c.req.param('id');
  try {
    const res = await fetch(`${AGENT_URL()}/api/tasks/${id}/run`, { method: 'POST' });
    if (!res.ok) {
      const error = await res.text();
      return c.text(`Failed to run task: ${error}`, 500);
    }
    return c.text('Task queued for execution', 200);
  } catch {
    return c.text('Error triggering task', 500);
  }
});
