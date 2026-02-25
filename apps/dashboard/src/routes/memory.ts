import { Hono } from 'hono';
import { layout } from '../views/layout.js';

const app = new Hono();

interface MemoryResult {
  id: string;
  category: string;
  content: string;
  score?: number;
  createdAt: string;
}

function renderResults(results: MemoryResult[], showScore = true): string {
  if (results.length === 0) {
    return '<p class="meta">No results found.</p>';
  }

  return results
    .map(
      (r) => `
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem">
          <span class="badge">${r.category}</span>
          ${showScore && typeof r.score === 'number' ? `<span class="score">score: ${r.score.toFixed(3)}</span>` : '<span class="meta">latest</span>'}
        </div>
        <p>${r.content}</p>
        <p class="meta">${new Date(r.createdAt).toLocaleString()}</p>
      </div>`
    )
    .join('');
}

// Proxy the graph data from the agent API
app.get('/api/memory/graph', async (c) => {
  try {
    const agentUrl = process.env.AGENT_API_URL ?? 'http://localhost:3001';
    const qs = new URLSearchParams();
    const limit = c.req.query('limit');
    const threshold = c.req.query('threshold');
    if (limit) qs.set('limit', limit);
    if (threshold) qs.set('threshold', threshold);
    const res = await fetch(`${agentUrl}/api/memory/graph?${qs.toString()}`);
    if (!res.ok) return c.json({ error: 'Agent error' }, 502);
    const data = await res.json();
    return c.json(data);
  } catch {
    return c.json({ error: 'Agent unreachable' }, 503);
  }
});

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
      resultsHtml = renderResults(data.memories, true);
    } catch {
      resultsHtml = '<p class="badge badge--red">Agent unreachable</p>';
    }
  }

  if (isHtmx) return c.html(resultsHtml || '<p class="meta">No results found.</p>');

  const content = `
    <h1>Memory</h1>

    <div style="display:flex;gap:0.5rem;margin-bottom:1.25rem">
      <button id="tab-graph-btn" class="btn btn--primary btn--sm" onclick="switchMemoryTab('graph')">Graph</button>
      <button id="tab-search-btn" class="btn btn--sm" onclick="switchMemoryTab('search')">Search</button>
    </div>

    <div id="pane-search" style="display:none">
      <form style="margin-bottom:1rem">
        <input
          type="search" name="q" placeholder="Search memories..."
          value="${query}"
          hx-get="/memory" hx-target="#results" hx-trigger="input changed delay:300ms, search"
          hx-include="this"
        />
      </form>
      <div id="results">${resultsHtml}</div>
    </div>

    <div id="pane-graph">
      <div style="display:flex;align-items:center;gap:1rem;margin-bottom:0.75rem;flex-wrap:wrap">
        <div style="display:flex;gap:1rem;font-size:0.78rem;color:#8b949e">
          <span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#58a6ff;margin-right:4px"></span>episodic</span>
          <span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#3fb950;margin-right:4px"></span>semantic</span>
          <span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#d29922;margin-right:4px"></span>procedural</span>
        </div>
        <span class="meta" style="margin-left:auto">Edges shown where similarity &ge; 0.6 &nbsp;&middot;&nbsp; click a node to inspect</span>
      </div>
      <div id="cy" style="width:100%;height:520px;background:#161b22;border:1px solid #30363d;border-radius:8px;position:relative">
        <div id="cy-loading" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#8b949e;font-size:0.85rem">Loading graph…</div>
      </div>
      <div id="node-info" style="margin-top:0.75rem;display:none">
        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem">
            <span id="ni-badge" class="badge"></span>
            <span id="ni-date" class="meta"></span>
          </div>
          <p id="ni-content" style="white-space:pre-wrap"></p>
        </div>
      </div>
    </div>

    <script src="https://unpkg.com/cytoscape@3.30.2/dist/cytoscape.min.js"></script>
    <script>
      let cyInstance = null;
      let graphLoaded = false;

      function switchMemoryTab(name) {
        const isSearch = name === 'search';
        document.getElementById('pane-search').style.display = isSearch ? '' : 'none';
        document.getElementById('pane-graph').style.display = isSearch ? 'none' : '';
        document.getElementById('tab-search-btn').className = isSearch ? 'btn btn--primary btn--sm' : 'btn btn--sm';
        document.getElementById('tab-graph-btn').className = isSearch ? 'btn btn--sm' : 'btn btn--primary btn--sm';
        if (!isSearch) loadGraph();
      }

      // Graph is the default tab — load immediately
      loadGraph();

      async function loadGraph() {
        if (graphLoaded) return;
        graphLoaded = true;

        let data;
        try {
          const res = await fetch('/api/memory/graph');
          data = await res.json();
        } catch (e) {
          document.getElementById('cy-loading').textContent = 'Agent unreachable';
          graphLoaded = false;
          return;
        }

        if (data.error) {
          document.getElementById('cy-loading').textContent = data.error;
          graphLoaded = false;
          return;
        }

        const { nodes, edges } = data;

        if (!nodes || nodes.length === 0) {
          document.getElementById('cy-loading').textContent = 'No memories yet.';
          return;
        }

        const categoryColor = {
          episodic: '#58a6ff',
          semantic: '#3fb950',
          procedural: '#d29922',
        };

        const cyNodes = nodes.map((n) => ({
          data: { id: n.id, label: n.content.slice(0, 30) + (n.content.length > 30 ? '…' : ''), ...n },
          style: { 'background-color': categoryColor[n.category] || '#8b949e' },
        }));

        const cyEdges = edges.map((e, i) => ({
          data: { id: 'e' + i, source: e.source, target: e.target, weight: e.weight },
        }));

        document.getElementById('cy-loading').style.display = 'none';

        cyInstance = cytoscape({
          container: document.getElementById('cy'),
          elements: { nodes: cyNodes, edges: cyEdges },
          style: [
            {
              selector: 'node',
              style: {
                'width': 22,
                'height': 22,
                'border-width': 2,
                'border-color': '#30363d',
                'label': 'data(label)',
                'font-size': 9,
                'color': '#8b949e',
                'text-valign': 'bottom',
                'text-halign': 'center',
                'text-margin-y': 4,
                'text-max-width': 120,
                'text-wrap': 'ellipsis',
                'overlay-padding': 6,
              },
            },
            {
              selector: 'node:selected',
              style: {
                'border-color': '#f0f6fc',
                'border-width': 3,
              },
            },
            {
              selector: 'edge',
              style: {
                'width': 'mapData(weight, 0.6, 1, 1, 4)',
                'line-color': '#30363d',
                'opacity': 'mapData(weight, 0.6, 1, 0.3, 0.8)',
                'curve-style': 'bezier',
              },
            },
            {
              selector: 'edge:selected',
              style: { 'line-color': '#58a6ff' },
            },
          ],
          layout: {
            name: 'cose',
            animate: true,
            animationDuration: 600,
            nodeRepulsion: () => 450000,
            nodeOverlap: 12,
            idealEdgeLength: () => 90,
            edgeElasticity: () => 100,
            gravity: 80,
            randomize: false,
            fit: true,
            padding: 24,
          },
          userZoomingEnabled: true,
          userPanningEnabled: true,
          boxSelectionEnabled: false,
        });

        cyInstance.on('tap', 'node', (evt) => {
          const node = evt.target.data();
          document.getElementById('ni-badge').textContent = node.category;
          document.getElementById('ni-badge').className = 'badge' + (
            node.category === 'semantic' ? ' badge--green'
            : node.category === 'procedural' ? ' badge--yellow'
            : ''
          );
          document.getElementById('ni-content').textContent = node.content;
          document.getElementById('ni-date').textContent = new Date(node.createdAt).toLocaleString();
          document.getElementById('node-info').style.display = '';
        });

        cyInstance.on('tap', (evt) => {
          if (evt.target === cyInstance) {
            document.getElementById('node-info').style.display = 'none';
          }
        });
      }
    </script>`;

  return c.html(layout('Memory', content));
});

export default app;
