#!/usr/bin/env node
/**
 * Standalone MCP server exposing Jonas memory + vault tools.
 * Spawned by the claude CLI via --mcp-config. Communicates over stdio.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { MemoryClient } from './memory/client.js';
import { EmbeddingClient } from './memory/embeddings.js';
import type { MemoryCategory } from '@jonas/shared/types';

const VAULT_PATH = process.env.VAULT_PATH ?? '/data/vault';

function safePath(path: string): string {
  const resolved = join(VAULT_PATH, path);
  if (!resolved.startsWith(VAULT_PATH)) {
    throw new Error('Path traversal blocked');
  }
  return resolved;
}

const server = new McpServer({ name: 'jonas', version: '0.1.0' });

// Lazy-init clients on first tool call
let memory: MemoryClient | null = null;
let embeddings: EmbeddingClient | null = null;

async function getClients() {
  if (!memory) {
    memory = new MemoryClient();
    await memory.ensureCollections();
  }
  if (!embeddings) {
    embeddings = new EmbeddingClient();
  }
  return { memory, embeddings };
}

// --- Memory tools ---

server.tool(
  'memory_remember',
  'Store a memory for future recall. Use this to remember facts, preferences, decisions, or procedures.',
  {
    content: z.string().describe('The information to remember'),
    category: z.enum(['episodic', 'semantic', 'procedural']).describe(
      'episodic=events/experiences, semantic=facts/preferences, procedural=how-to/processes',
    ),
  },
  async ({ content, category }) => {
    const { memory, embeddings } = await getClients();
    const [embedding] = await embeddings.embed([content]);
    const id = await memory.upsert(category as MemoryCategory, content, embedding, {}, 'agent');
    return {
      content: [{ type: 'text', text: JSON.stringify({ success: true, id, message: `Remembered: "${content.slice(0, 80)}..."` }) }],
    };
  },
);

server.tool(
  'memory_recall',
  'Search memories by semantic similarity. Use this to find relevant context before answering.',
  {
    query: z.string().describe('What to search for'),
    category: z.enum(['all', 'episodic', 'semantic', 'procedural']).default('all').describe('Category to search, or "all"'),
    limit: z.number().default(5).describe('Max results'),
  },
  async ({ query, category, limit }) => {
    const { memory, embeddings } = await getClients();
    const embedding = await embeddings.embedQuery(query);
    const results = await memory.search(
      (category ?? 'all') as MemoryCategory | 'all',
      embedding,
      limit ?? 5,
    );
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          count: results.length,
          memories: results.map((r) => ({
            id: r.memory.id,
            category: r.memory.category,
            content: r.memory.content,
            score: Math.round(r.score * 100) / 100,
            createdAt: r.memory.createdAt,
          })),
        }),
      }],
    };
  },
);

server.tool(
  'memory_forget',
  'Delete a specific memory by ID.',
  {
    id: z.string().describe('Memory ID to delete'),
    category: z.enum(['episodic', 'semantic', 'procedural']).describe('Category of the memory'),
  },
  async ({ id, category }) => {
    const { memory } = await getClients();
    await memory.delete(category as MemoryCategory, id);
    return {
      content: [{ type: 'text', text: JSON.stringify({ success: true, message: `Memory ${id} deleted` }) }],
    };
  },
);

// --- Vault tools ---

server.tool(
  'vault_read',
  'Read a file from the Obsidian vault.',
  { path: z.string().describe('Relative path within the vault (e.g., "daily/2025-01-15.md")') },
  async ({ path }) => {
    const fullPath = safePath(path);
    try {
      const content = await readFile(fullPath, 'utf-8');
      return { content: [{ type: 'text', text: JSON.stringify({ path, content }) }] };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { content: [{ type: 'text', text: JSON.stringify({ error: `File not found: ${path}` }) }], isError: true };
      }
      throw err;
    }
  },
);

server.tool(
  'vault_write',
  'Write or update a file in the Obsidian vault. Supports [[wiki-links]] and standard markdown.',
  {
    path: z.string().describe('Relative path within the vault'),
    content: z.string().describe('Markdown content to write'),
    append: z.boolean().default(false).describe('Append instead of overwrite'),
  },
  async ({ path, content, append }) => {
    const fullPath = safePath(path);
    await mkdir(dirname(fullPath), { recursive: true });
    if (append) {
      const existing = await readFile(fullPath, 'utf-8').catch(() => '');
      await writeFile(fullPath, existing + '\n' + content, 'utf-8');
    } else {
      await writeFile(fullPath, content, 'utf-8');
    }
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, path }) }] };
  },
);

server.tool(
  'vault_search',
  'Search the vault for files containing a query string.',
  {
    query: z.string().describe('Text to search for'),
    directory: z.string().default('').describe('Subdirectory to search in (optional)'),
  },
  async ({ query, directory }) => {
    const searchDir = safePath(directory ?? '');
    const results: { path: string; snippet: string }[] = [];

    async function walk(dir: string) {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!entry.name.startsWith('.')) await walk(fullPath);
        } else if (entry.name.endsWith('.md')) {
          const content = await readFile(fullPath, 'utf-8');
          const idx = content.toLowerCase().indexOf(query.toLowerCase());
          if (idx !== -1) {
            const start = Math.max(0, idx - 50);
            const end = Math.min(content.length, idx + query.length + 50);
            results.push({ path: relative(VAULT_PATH, fullPath), snippet: content.slice(start, end).trim() });
          }
        }
      }
    }

    await walk(searchDir);
    return { content: [{ type: 'text', text: JSON.stringify({ count: results.length, results: results.slice(0, 20) }) }] };
  },
);

// --- Task scheduler tools (call agent API) ---

const AGENT_API = process.env.AGENT_API_URL ?? 'http://localhost:3001';

server.tool(
  'task_schedule',
  'Schedule a recurring task. The task will run on the cron schedule and execute the prompt via Claude. Optionally specify a target channel for output delivery.',
  {
    name: z.string().describe('Human-readable name for the task'),
    cron: z.string().describe('Cron expression (e.g., "0 8 * * *" for daily at 8am)'),
    prompt: z.string().describe('Natural language instruction for Claude to execute'),
    targetChannelType: z.string().optional().describe('Output channel type (e.g., "dashboard")'),
    targetChannelId: z.string().optional().describe('Output channel ID'),
  },
  async ({ name, cron, prompt, targetChannelType, targetChannelId }) => {
    const targetChannel = targetChannelType && targetChannelId
      ? { type: targetChannelType, id: targetChannelId }
      : undefined;
    const res = await fetch(`${AGENT_API}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, cron, prompt, targetChannel }),
    });
    const data = await res.json();
    if (!res.ok) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: data.error ?? 'Failed to create task' }) }], isError: true };
    }
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, task: data }) }] };
  },
);

server.tool(
  'task_list',
  'List all scheduled tasks.',
  {},
  async () => {
    const res = await fetch(`${AGENT_API}/api/tasks`);
    const data = await res.json();
    return { content: [{ type: 'text', text: JSON.stringify(data) }] };
  },
);

server.tool(
  'task_remove',
  'Remove a scheduled task by ID.',
  {
    id: z.string().describe('Task ID to remove'),
  },
  async ({ id }) => {
    const res = await fetch(`${AGENT_API}/api/tasks/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: data.error ?? 'Failed to remove task' }) }], isError: true };
    }
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, message: `Task ${id} removed` }) }] };
  },
);

server.tool(
  'task_update',
  'Update a scheduled task. Can change name, cron schedule, prompt, target channel, or enable/disable.',
  {
    id: z.string().describe('Task ID to update'),
    name: z.string().optional().describe('New name'),
    cron: z.string().optional().describe('New cron expression'),
    prompt: z.string().optional().describe('New prompt'),
    targetChannelType: z.string().optional().describe('New output channel type'),
    targetChannelId: z.string().optional().describe('New output channel ID'),
    enabled: z.boolean().optional().describe('Enable or disable the task'),
  },
  async ({ id, targetChannelType, targetChannelId, ...rest }) => {
    // Filter out undefined values
    const body: Record<string, unknown> = Object.fromEntries(
      Object.entries(rest).filter(([, v]) => v !== undefined),
    );
    if (targetChannelType && targetChannelId) {
      body.targetChannel = { type: targetChannelType, id: targetChannelId };
    }
    const res = await fetch(`${AGENT_API}/api/tasks/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: data.error ?? 'Failed to update task' }) }], isError: true };
    }
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, task: data }) }] };
  },
);

// --- Skill management tools (call agent API) ---

server.tool(
  'skill_list',
  'List all available skills and their status.',
  {},
  async () => {
    const res = await fetch(`${AGENT_API}/api/skills`);
    const data = await res.json();
    return { content: [{ type: 'text', text: JSON.stringify(data) }] };
  },
);

server.tool(
  'skill_enable',
  'Enable a skill by name.',
  {
    name: z.string().describe('Skill directory name to enable'),
  },
  async ({ name }) => {
    const res = await fetch(`${AGENT_API}/api/skills/${name}/enable`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: data.error ?? 'Failed' }) }], isError: true };
    }
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, message: `Skill "${name}" enabled` }) }] };
  },
);

server.tool(
  'skill_disable',
  'Disable a skill by name.',
  {
    name: z.string().describe('Skill directory name to disable'),
  },
  async ({ name }) => {
    const res = await fetch(`${AGENT_API}/api/skills/${name}/disable`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: data.error ?? 'Failed' }) }], isError: true };
    }
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, message: `Skill "${name}" disabled` }) }] };
  },
);

server.tool(
  'skill_create',
  `Create a new skill. A skill is a directory in /data/skills/ containing:
- skill.md: YAML frontmatter (name, description, version, author) + markdown instructions for Claude
- config.json (optional): { requiredSecrets: string[], pythonDependencies: string[] }
- tools/server.py (optional): Python FastMCP server providing MCP tools (communicates via stdio)
- requirements.txt (optional): Python pip dependencies for the tool server

The skill.md body becomes part of the system prompt when the skill is enabled.
The tool server (if provided) is spawned as a child process and its tools become available to Claude.`,
  {
    dirName: z.string().describe('Directory name for the skill (lowercase, hyphens, e.g., "gmail-summary")'),
    skillMd: z.string().describe('Full content of skill.md including YAML frontmatter (---\\nname: ...\\n---) and markdown body with instructions'),
    configJson: z.string().optional().describe('JSON string for config.json (e.g., {"requiredSecrets":["API_KEY"]})'),
    toolServerPy: z.string().optional().describe('Python source code for tools/server.py (FastMCP server)'),
    requirementsTxt: z.string().optional().describe('Contents of requirements.txt (pip dependencies, one per line)'),
  },
  async ({ dirName, skillMd, configJson, toolServerPy, requirementsTxt }) => {
    const body: Record<string, unknown> = { dirName, skillMd };
    if (configJson) {
      try { body.config = JSON.parse(configJson); } catch { body.config = undefined; }
    }
    if (toolServerPy) body.toolServerPy = toolServerPy;
    if (requirementsTxt) body.requirementsTxt = requirementsTxt;

    const res = await fetch(`${AGENT_API}/api/skills`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: data.error ?? 'Failed to create skill' }) }], isError: true };
    }
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, skill: data }) }] };
  },
);

server.tool(
  'skill_set_value',
  'Set an API key or config value for a skill. Used to provide credentials the skill needs.',
  {
    name: z.string().describe('Skill directory name'),
    key: z.string().describe('Value key (e.g., "NEWS_API_KEY")'),
    value: z.string().describe('Value to store (will be encrypted if master key is set)'),
  },
  async ({ name, key, value }) => {
    const res = await fetch(`${AGENT_API}/api/skills/${name}/values`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value }),
    });
    const data = await res.json();
    if (!res.ok) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: data.error ?? 'Failed' }) }], isError: true };
    }
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, message: `Value "${key}" set for skill "${name}"` }) }] };
  },
);

// --- OAuth tools (chat-guided OAuth) ---

server.tool(
  'skill_set_oauth_provider',
  'Store OAuth app credentials (client ID and secret) for a specific skill\'s OAuth key. The user must first create an OAuth app in the provider\'s developer console.',
  {
    skillDirName: z.string().describe('Skill directory name'),
    secretKey: z.string().describe('The OAuth key name from the skill config (e.g., "GMAIL_TOKEN")'),
    clientId: z.string().describe('OAuth client ID from the provider'),
    clientSecret: z.string().describe('OAuth client secret from the provider'),
  },
  async ({ skillDirName, secretKey, clientId, clientSecret }) => {
    const res = await fetch(`${AGENT_API}/api/skills/${encodeURIComponent(skillDirName)}/oauth-provider/${encodeURIComponent(secretKey)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, clientSecret }),
    });
    const data = await res.json();
    if (!res.ok) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: data.error ?? 'Failed to store credentials' }) }], isError: true };
    }
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, message: `OAuth credentials stored for ${skillDirName}/${secretKey}` }) }] };
  },
);

server.tool(
  'skill_oauth_link',
  'Generate a clickable OAuth authorization URL that the user can click in chat to connect a service. Returns the URL to include in a markdown link.',
  {
    skillDirName: z.string().describe('Skill directory name'),
    secretKey: z.string().describe('The OAuth key name from the skill config (e.g., "GMAIL_TOKEN")'),
    provider: z.string().describe('OAuth provider ID (e.g., "google", "github")'),
    scopes: z.array(z.string()).describe('OAuth scopes to request'),
  },
  async ({ skillDirName, secretKey, provider, scopes }) => {
    const dashboardUrl = process.env.DASHBOARD_URL ?? 'http://localhost:3000';
    const params = new URLSearchParams({
      provider,
      scopes: scopes.join(','),
    });
    const connectUrl = `${dashboardUrl}/oauth/connect/${encodeURIComponent(skillDirName)}/${encodeURIComponent(secretKey)}?${params.toString()}`;

    // Check if provider credentials are configured
    const res = await fetch(`${AGENT_API}/api/skills/${encodeURIComponent(skillDirName)}`);
    let credentialsConfigured = false;
    if (res.ok) {
      const skill = await res.json();
      const secretKeys = skill.secretKeys ?? [];
      credentialsConfigured = secretKeys.includes(`__oauth_${secretKey}_client_id`);
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          connectUrl,
          credentialsConfigured,
          message: credentialsConfigured
            ? `OAuth link ready. Share this with the user: [Connect ${provider}](${connectUrl})`
            : `OAuth credentials not yet configured for ${secretKey}. Use skill_set_oauth_provider first, then generate the link again.`,
        }),
      }],
    };
  },
);

// Start
const transport = new StdioServerTransport();
await server.connect(transport);
