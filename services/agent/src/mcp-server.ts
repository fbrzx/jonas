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

server.tool(
  'vault_append_daily',
  'Append content to today\'s daily note. Creates the note if it doesn\'t exist.',
  {
    content: z.string().describe('Content to append'),
    section: z.string().optional().describe('Optional section heading (e.g., "Tasks", "Notes")'),
  },
  async ({ content, section }) => {
    const today = new Date().toISOString().split('T')[0];
    const dailyPath = `daily/${today}.md`;
    const fullPath = safePath(dailyPath);

    await mkdir(dirname(fullPath), { recursive: true });

    // Check if file exists
    let existing = '';
    try {
      existing = await readFile(fullPath, 'utf-8');
    } catch {
      // Create new daily note with frontmatter
      existing = `---
title: Daily Note - ${today}
tags: [daily]
created: ${new Date().toISOString()}
---

# ${today}

`;
    }

    // Append entry
    const timestamp = new Date().toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
    });

    let entry = '\n';
    if (section) {
      entry += `## ${section}\n\n`;
    } else {
      entry += `## ${timestamp}\n\n`;
    }
    entry += content + '\n';

    await writeFile(fullPath, existing + entry, 'utf-8');

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          path: dailyPath,
          message: 'Entry added to daily note. Run sync script locally to pull changes.',
        }),
      }],
    };
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
    const data = await res.json() as { error?: string };
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
    const data = await res.json() as unknown;
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
    const data = await res.json() as { error?: string };
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
    const data = await res.json() as { error?: string };
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
    const data = await res.json() as unknown;
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
    const res = await fetch(`${AGENT_API}/api/skills/${encodeURIComponent(name)}/enable`, { method: 'POST' });
    const data = await res.json() as { error?: string };
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
    const res = await fetch(`${AGENT_API}/api/skills/${encodeURIComponent(name)}/disable`, { method: 'POST' });
    const data = await res.json() as { error?: string };
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
- config.json (optional): declares what the skill needs
- tools/server.py (optional): Python FastMCP server providing MCP tools (communicates via stdio)
- requirements.txt (optional): Python pip dependencies for the tool server

The skill.md body becomes part of the system prompt when the skill is enabled.
The tool server (if provided) is spawned as a child process and its tools become available to Claude.

config.json structure:
{
  "requiredSecrets": ["API_KEY"],           // API keys the skill needs (set via skill_set_value)
  "oauth": {                                // OAuth tokens the skill needs
    "GMAIL_TOKEN": {                        // key name — token stored under this name
      "provider": "google",                 // provider ID (google, github, or custom)
      "scopes": ["https://www.googleapis.com/auth/gmail.readonly"]
    }
  },
  "pythonDependencies": ["requests"]        // pip packages for the tool server
}

For OAuth skills: after creating, use skill_set_oauth_provider to store the user's OAuth app credentials,
then skill_oauth_link to generate a clickable authorization URL for the user.`,
  {
    dirName: z.string().describe('Directory name for the skill (lowercase, hyphens, e.g., "gmail-summary")'),
    skillMd: z.string().describe('Full content of skill.md including YAML frontmatter (---\\nname: ...\\n---) and markdown body with instructions'),
    configJson: z.string().optional().describe('JSON string for config.json. For OAuth skills include the oauth field, e.g., {"oauth":{"GMAIL_TOKEN":{"provider":"google","scopes":["https://www.googleapis.com/auth/gmail.readonly"]}}}'),
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
    const data = await res.json() as { error?: string; dirName?: string; metadata?: { name?: string }; config?: { requiredSecrets?: string[]; oauth?: Record<string, unknown> } };
    if (!res.ok) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: data.error ?? 'Failed to create skill' }) }], isError: true };
    }

    // Build helpful next steps message
    const dashboardUrl = process.env.DASHBOARD_URL ?? 'http://localhost:3000';
    const skillUrl = `${dashboardUrl}/skills/${encodeURIComponent(data.dirName ?? 'unknown')}`;
    const hasConfig = data.config?.requiredSecrets || data.config?.oauth;

    let nextSteps = `Skill "${data.metadata?.name ?? 'Unknown'}" created successfully!`;

    if (hasConfig) {
      nextSteps += `\n\n⚠️ This skill requires configuration before it can be used.`;
      nextSteps += `\n\nPlease visit the dashboard to set up the required credentials:`;
      nextSteps += `\n${skillUrl}`;

      if (data.config?.oauth) {
        const oauthKeys = Object.keys(data.config.oauth);
        nextSteps += `\n\nOAuth connections needed: ${oauthKeys.join(', ')}`;
      }

      if (data.config?.requiredSecrets) {
        nextSteps += `\n\nAPI keys needed: ${data.config.requiredSecrets.join(', ')}`;
      }

      nextSteps += `\n\nAlternatively, you can use the skill_set_value and skill_set_oauth_provider tools to configure the skill via chat.`;
    } else {
      nextSteps += `\n\nThe skill is ready to use. Enable it from: ${skillUrl}`;
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          skill: data,
          message: nextSteps,
        }, null, 2)
      }]
    };
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
    const res = await fetch(`${AGENT_API}/api/skills/${encodeURIComponent(name)}/values`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value }),
    });
    const data = await res.json() as { error?: string };
    if (!res.ok) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: data.error ?? 'Failed' }) }], isError: true };
    }
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, message: `Value "${key}" set for skill "${name}"` }) }] };
  },
);

server.tool(
  'skill_get_config',
  'Get the config.json for a skill.',
  {
    name: z.string().describe('Skill directory name'),
  },
  async ({ name }) => {
    const res = await fetch(`${AGENT_API}/api/skills/${encodeURIComponent(name)}/config`);
    const data = await res.json() as { error?: string };
    if (!res.ok) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: data.error ?? 'Failed' }) }], isError: true };
    }
    return { content: [{ type: 'text', text: JSON.stringify(data) }] };
  },
);

server.tool(
  'skill_update_config',
  'Update the config.json for a skill. Replaces the entire config.json file.',
  {
    name: z.string().describe('Skill directory name'),
    configJson: z.string().describe('New config.json content as JSON string'),
  },
  async ({ name, configJson }) => {
    let config;
    try {
      config = JSON.parse(configJson);
    } catch {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'Invalid JSON in configJson' }) }], isError: true };
    }

    const res = await fetch(`${AGENT_API}/api/skills/${encodeURIComponent(name)}/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    const data = await res.json() as { error?: string };
    if (!res.ok) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: data.error ?? 'Failed to update config' }) }], isError: true };
    }
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, message: `Config updated for skill "${name}"` }) }] };
  },
);

server.tool(
  'skill_delete',
  'Delete a skill completely. This removes the skill directory and all its files. Cannot be undone.',
  {
    name: z.string().describe('Skill directory name'),
  },
  async ({ name }) => {
    const res = await fetch(`${AGENT_API}/api/skills/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    });
    const data = await res.json() as { error?: string };
    if (!res.ok) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: data.error ?? 'Failed to delete skill' }) }], isError: true };
    }
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, message: `Skill "${name}" deleted` }) }] };
  },
);

server.tool(
  'skill_export',
  'Export a skill as a .zip file. Returns a base64-encoded zip that can be shared or saved.',
  {
    name: z.string().describe('Skill directory name'),
  },
  async ({ name }) => {
    const res = await fetch(`${AGENT_API}/api/skills/${encodeURIComponent(name)}/export`);
    if (!res.ok) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'Skill not found or export failed' }) }], isError: true };
    }
    const buffer = await res.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          message: `Skill "${name}" exported`,
          filename: `${name}.zip`,
          size: buffer.byteLength,
          base64: base64.slice(0, 100) + '...' // truncate for display
        })
      }]
    };
  },
);

server.tool(
  'skill_import',
  'Import a skill from a .zip file. Provide the base64-encoded zip content.',
  {
    base64Zip: z.string().describe('Base64-encoded .zip file content'),
    overwrite: z.boolean().optional().describe('Overwrite if skill already exists (default: false)'),
  },
  async ({ base64Zip, overwrite }) => {
    try {
      const buffer = Buffer.from(base64Zip, 'base64');
      const formData = new FormData();
      const blob = new Blob([buffer], { type: 'application/zip' });
      formData.append('file', blob, 'skill.zip');
      if (overwrite) {
        formData.append('overwrite', 'true');
      }

      const res = await fetch(`${AGENT_API}/api/skills/import`, {
        method: 'POST',
        body: formData,
      });

      const data = await res.json() as { error?: string; skill?: unknown };
      if (!res.ok) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: data.error ?? 'Import failed' }) }], isError: true };
      }
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, skill: data.skill }) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: (err as Error).message }) }], isError: true };
    }
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
    const data = await res.json() as { error?: string };
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
      const skill = await res.json() as { secretKeys?: string[] };
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

// --- Channel tools ---

server.tool(
  'channel_create',
  `Create a new communication channel. A channel is a directory in /data/channels/ containing:
- channel.md: YAML frontmatter (name, platform, version, author, mode) + markdown description
- config.json: declares required/optional secrets and channel configuration
- handler.py (recommended) OR handler.js: Channel handler implementation

Channels enable Jonas to connect to communication platforms (Telegram, Slack, Discord, WhatsApp, etc.).

PYTHON HANDLERS (Recommended):
Python handlers run as isolated child processes with their own dependencies (requirements.txt).
This keeps the Node.js core clean and allows channel-specific Python packages.

handler.py template:
from channels.python_handler import PythonChannelHandler

class MyChannelHandler(PythonChannelHandler):
    async def on_start(self):
        # Start webhook/polling
        pass

    async def on_stop(self):
        # Cleanup
        pass

    async def on_send(self, channel_id: str, text: str):
        # Send message to platform
        pass

def main():
    handler = MyChannelHandler()
    asyncio.run(handler.run())

if __name__ == "__main__":
    main()

JAVASCRIPT HANDLERS (Legacy):
handler.js must export an initialize function:
export async function initialize(config, secrets, sendToAgent) {
  return {
    start: async () => { /* start webhook or polling */ },
    stop: async () => { /* cleanup */ },
    send: async (channelId, text) => { /* send message */ }
  };
}

After creating, use channel_set_value to configure required secrets, then enable and start the channel via dashboard.`,
  {
    dirName: z.string().describe('Directory name for the channel (lowercase, hyphens, e.g., "slack")'),
    channelMd: z.string().describe('Full content of channel.md including YAML frontmatter (---\\nname: ...\\nplatform: ...\\n---) and markdown description'),
    configJson: z.string().optional().describe('JSON string for config.json, e.g., {"requiredSecrets":["SLACK_BOT_TOKEN"],"mode":"webhook","port":3003}'),
    handlerPy: z.string().optional().describe('Python source code for handler.py (PythonChannelHandler subclass). RECOMMENDED for new channels.'),
    requirementsTxt: z.string().optional().describe('Python dependencies (pip packages, one per line). Only used with handlerPy.'),
    handlerJs: z.string().optional().describe('JavaScript source code for handler.js (ES module implementing ChannelHandler interface). Legacy option.'),
  },
  async ({ dirName, channelMd, configJson, handlerPy, requirementsTxt, handlerJs }) => {
    const body: Record<string, unknown> = {
      dirName,
      metadata: {} as Record<string, unknown>,
    };

    // Parse channel.md frontmatter
    const match = channelMd.match(/^---\n([\s\S]+?)\n---/);
    if (match) {
      const yaml = match[1];
      const lines = yaml.split('\n');
      for (const line of lines) {
        const [key, ...valueParts] = line.split(':');
        if (key && valueParts.length) {
          const value = valueParts.join(':').trim();
          (body.metadata as Record<string, string>)[key.trim()] = value;
        }
      }
    }

    if (configJson) {
      try { body.config = JSON.parse(configJson); } catch { body.config = undefined; }
    }

    if (handlerPy) {
      body.handlerPy = handlerPy;
    }

    if (requirementsTxt) {
      body.requirementsTxt = requirementsTxt;
    }

    const res = await fetch(`${AGENT_API}/api/channels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json() as { error?: string; dirName?: string; metadata?: { name?: string }; config?: { requiredSecrets?: string[] } };
    if (!res.ok) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: data.error ?? 'Failed to create channel' }) }], isError: true };
    }

    // Write handler.js if provided (legacy support)
    if (handlerJs) {
      try {
        await writeFile(`/data/channels/${dirName}/handler.js`, handlerJs);
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Failed to write handler.js' }) }], isError: true };
      }
    }

    // Build helpful next steps message
    const dashboardUrl = process.env.DASHBOARD_URL ?? 'http://localhost:3000';
    const channelUrl = `${dashboardUrl}/channels/${encodeURIComponent(data.dirName ?? 'unknown')}`;
    const hasConfig = data.config?.requiredSecrets && data.config.requiredSecrets.length > 0;

    let nextSteps = `Channel "${data.metadata?.name ?? 'Unknown'}" created successfully!`;

    if (hasConfig) {
      nextSteps += `\n\n⚠️ This channel requires configuration before it can be used.`;
      nextSteps += `\n\nPlease visit the dashboard to configure the required secrets:`;
      nextSteps += `\n${channelUrl}`;
      nextSteps += `\n\nRequired secrets: ${data.config!.requiredSecrets!.join(', ')}`;
      nextSteps += `\n\nAlternatively, use the channel_set_value tool to configure the channel via chat.`;
    } else {
      nextSteps += `\n\nThe channel is ready to use. Configure and enable it from: ${channelUrl}`;
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          channel: data,
          message: nextSteps,
        }, null, 2)
      }]
    };
  },
);

server.tool(
  'channel_set_value',
  'Set a secret value (like bot token or API key) for a channel. Used to provide credentials the channel needs.',
  {
    name: z.string().describe('Channel directory name'),
    key: z.string().describe('Secret key (e.g., "TELEGRAM_BOT_TOKEN")'),
    value: z.string().describe('Value to store (will be encrypted)'),
  },
  async ({ name, key, value }) => {
    const res = await fetch(`${AGENT_API}/api/channels/${encodeURIComponent(name)}/values`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value }),
    });

    if (!res.ok) {
      const data = await res.json() as { error?: string };
      return { content: [{ type: 'text', text: JSON.stringify({ error: data.error ?? 'Failed to set value' }) }], isError: true };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          message: `Set ${key} for channel "${name}". The value is encrypted and stored securely.`
        })
      }]
    };
  },
);

// Start
const transport = new StdioServerTransport();
await server.connect(transport);
