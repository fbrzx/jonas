import { Hono } from 'hono';
import { layout } from '../views/layout.js';

const app = new Hono();

interface Skill {
  metadata: {
    name: string;
    description: string;
    version: string;
    author: string;
  };
  status: 'enabled' | 'disabled';
  hasTools: boolean;
  hasPrompt: boolean;
  secretKeys?: string[];
}

function renderSkills(skills: Skill[]): string {
  if (skills.length === 0) {
    return '<p class="meta">No skills installed. Add skill directories to <code>/data/skills-custom/</code>.</p>';
  }

  const rows = skills
    .map(
      (s) => `
      <tr>
        <td><strong>${s.metadata.name}</strong><br><span class="meta">${s.metadata.description}</span></td>
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
            hx-post="/skills/${encodeURIComponent(s.metadata.name)}/${s.status === 'enabled' ? 'disable' : 'enable'}"
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

app.get('/skills', async (c) => {
  try {
    const agentUrl = process.env.AGENT_API_URL ?? 'http://localhost:3001';
    const res = await fetch(`${agentUrl}/api/skills`);
    const data = (await res.json()) as Skill[];
    return c.html(layout('Skills', `<h1>Skills</h1>${renderSkills(data)}`));
  } catch {
    return c.html(
      layout('Skills', '<h1>Skills</h1><p class="badge badge--red">Agent unreachable</p>'),
    );
  }
});

// HTMX toggle endpoints (proxy to agent API)
app.post('/skills/:name/enable', async (c) => {
  const name = c.req.param('name');
  const agentUrl = process.env.AGENT_API_URL ?? 'http://localhost:3001';
  try {
    await fetch(`${agentUrl}/api/skills/${name}/enable`, { method: 'POST' });
    // Re-fetch to get updated skill data
    const res = await fetch(`${agentUrl}/api/skills`);
    const skills = (await res.json()) as Skill[];
    const skill = skills.find((s) => s.metadata.name === name);
    if (!skill) return c.text('Skill not found', 404);
    return c.html(renderSkillRow(skill));
  } catch {
    return c.text('Agent unreachable', 502);
  }
});

app.post('/skills/:name/disable', async (c) => {
  const name = c.req.param('name');
  const agentUrl = process.env.AGENT_API_URL ?? 'http://localhost:3001';
  try {
    await fetch(`${agentUrl}/api/skills/${name}/disable`, { method: 'POST' });
    const res = await fetch(`${agentUrl}/api/skills`);
    const skills = (await res.json()) as Skill[];
    const skill = skills.find((s) => s.metadata.name === name);
    if (!skill) return c.text('Skill not found', 404);
    return c.html(renderSkillRow(skill));
  } catch {
    return c.text('Agent unreachable', 502);
  }
});

function renderSkillRow(s: Skill): string {
  return `
    <tr>
      <td><strong>${s.metadata.name}</strong><br><span class="meta">${s.metadata.description}</span></td>
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
          hx-post="/skills/${encodeURIComponent(s.metadata.name)}/${s.status === 'enabled' ? 'disable' : 'enable'}"
          hx-target="closest tr"
          hx-swap="outerHTML"
        >${s.status === 'enabled' ? 'Disable' : 'Enable'}</button>
      </td>
    </tr>`;
}

export default app;
