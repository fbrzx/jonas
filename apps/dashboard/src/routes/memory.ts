import { Hono } from 'hono';
import { layout } from '../views/layout.js';

const app = new Hono();

interface MemoryResult {
  id: string;
  category: string;
  content: string;
  score: number;
  createdAt: string;
}

function renderResults(results: MemoryResult[]): string {
  if (results.length === 0) {
    return '<p class="meta">No results found.</p>';
  }

  return results
    .map(
      (r) => `
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem">
          <span class="badge">${r.category}</span>
          <span class="score">score: ${r.score.toFixed(3)}</span>
        </div>
        <p>${r.content}</p>
        <p class="meta">${new Date(r.createdAt).toLocaleString()}</p>
      </div>`
    )
    .join('');
}

app.get('/memory', async (c) => {
  const query = c.req.query('q') ?? '';
  const isHtmx = c.req.header('HX-Request') === 'true';

  let resultsHtml = '';
  if (query) {
    try {
      const agentUrl = process.env.AGENT_API_URL ?? 'http://localhost:3001';
      const res = await fetch(
        `${agentUrl}/api/memory?q=${encodeURIComponent(query)}`
      );
      const data = (await res.json()) as { count: number; memories: MemoryResult[] };
      resultsHtml = renderResults(data.memories);
    } catch {
      resultsHtml = '<p class="badge badge--red">Agent unreachable</p>';
    }
  }

  if (isHtmx) return c.html(resultsHtml);

  const content = `
    <h1>Memory Browser</h1>
    <form style="margin-bottom:1rem">
      <input
        type="search" name="q" placeholder="Search memories..."
        value="${query}"
        hx-get="/memory" hx-target="#results" hx-trigger="input changed delay:300ms, search"
        hx-include="this"
      />
    </form>
    <div id="results">${resultsHtml}</div>`;

  return c.html(layout('Memory', content));
});

export default app;
