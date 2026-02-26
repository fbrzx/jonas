import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { writeFile } from 'node:fs/promises';
import { createLogger } from '@jonas/shared/utils';
import type { AgentCore } from '../agent/core.js';
import type { MemoryClient } from '../memory/client.js';
import type { MemoryRetriever } from '../memory/retriever.js';
import type { TaskScheduler } from '../tasks/scheduler.js';
import type { BackgroundJobManager } from '../tasks/job-manager.js';
import type { SkillRegistry } from '../skills/registry.js';
import type { OAuthProviderStore } from '../oauth/provider-store.js';
import type { OAuthHandler } from '../oauth/handler.js';
import type { ConversationDatabase } from '../storage/database.js';
import type { ChannelRegistry } from '../channels/registry.js';
import { ProviderFactory } from '../agent/providers/factory.js';
import type { ProviderConfig } from '../agent/providers/base.js';
import type { ChannelPairingService } from '../channels/pairing.js';
import type { ConnectionManager } from '../connections/manager.js';
import type { AgentRegistry } from '../agent/registry.js';

const log = createLogger('api');

interface ApiDeps {
  agent: AgentCore;
  agentRegistry?: AgentRegistry;
  memory: MemoryClient;
  retriever: MemoryRetriever;
  scheduler?: TaskScheduler;
  jobManager?: BackgroundJobManager;
  skillRegistry?: SkillRegistry;
  oauthProviderStore?: OAuthProviderStore;
  oauthHandler?: OAuthHandler;
  database?: ConversationDatabase;
  channelRegistry?: ChannelRegistry;
  pairingService?: ChannelPairingService;
  connectionManager?: ConnectionManager;
}

export function createApiServer(deps: ApiDeps) {
  const app = new Hono();
  const allowedOrigins = (process.env.AGENT_CORS_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (allowedOrigins.length > 0) {
    app.use('/api/*', cors({
      origin: allowedOrigins,
      allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization', 'x-agent-token'],
    }));
  }

  const agentApiToken = (process.env.AGENT_API_TOKEN ?? '').trim();
  if (!agentApiToken) {
    log.warn('AGENT_API_TOKEN is not set; agent API is running without token authentication');
  }

  app.use('/api/*', async (c, next) => {
    // Skip authentication for health check endpoint and OPTIONS requests
    if (!agentApiToken || c.req.method === 'OPTIONS' || c.req.path === '/api/status') {
      await next();
      return;
    }

    const authHeader = c.req.header('authorization') ?? '';
    const bearerToken = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7).trim()
      : '';
    const headerToken = (c.req.header('x-agent-token') ?? '').trim();
    const token = headerToken || bearerToken;

    if (token !== agentApiToken) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    await next();
  });

  // --- Channel pairing endpoints ---

  app.get('/api/pairing/status', (c) => {
    if (!deps.pairingService) return c.json({ error: 'Pairing service not available' }, 503);

    const channelType = c.req.query('channelType');
    if (!channelType) {
      return c.json({ error: 'Missing channelType query parameter' }, 400);
    }

    return c.json(deps.pairingService.getStatus(channelType));
  });

  app.post('/api/pairing/init', async (c) => {
    if (!deps.pairingService) return c.json({ error: 'Pairing service not available' }, 503);

    const { channelType } = await c.req.json<{ channelType?: string }>();
    if (!channelType) {
      return c.json({ error: 'Missing required field: channelType' }, 400);
    }

    const pairing = await deps.pairingService.init(channelType);
    return c.json(pairing);
  });

  app.post('/api/pairing/confirm', async (c) => {
    if (!deps.pairingService) return c.json({ error: 'Pairing service not available' }, 503);

    const { channelType, code } = await c.req.json<{ channelType?: string; code?: string }>();
    if (!channelType || !code) {
      return c.json({ error: 'Missing required fields: channelType, code' }, 400);
    }

    const ok = await deps.pairingService.confirm(channelType, code);
    if (!ok) {
      return c.json({ error: 'Invalid or expired pairing code' }, 400);
    }

    return c.json({ success: true, channelType, paired: true });
  });

  app.post('/api/pairing/revoke', async (c) => {
    if (!deps.pairingService) return c.json({ error: 'Pairing service not available' }, 503);

    const { channelType } = await c.req.json<{ channelType?: string }>();
    if (!channelType) {
      return c.json({ error: 'Missing required field: channelType' }, 400);
    }

    await deps.pairingService.revoke(channelType);
    return c.json({ success: true, channelType, paired: false });
  });

  // Health / status
  app.get('/api/status', async (c) => {
    const [episodic, semantic, procedural] = await Promise.all([
      deps.memory.count('episodic'),
      deps.memory.count('semantic'),
      deps.memory.count('procedural'),
    ]);

    return c.json({
      uptime: deps.agent.uptime,
      model: deps.agent.getProviderName(),
      memoryStats: { episodic, semantic, procedural },
      activeConversations: deps.agent.activeConversationCount,
      skillCount: deps.skillRegistry?.list().length ?? 0,
      channels: {
        dashboard: true,
        gateway: true,
      },
    });
  });

  // --- Model configuration endpoints ---

  app.get('/api/model/config', async (c) => {
    try {
      const config = await ProviderFactory.loadConfig('/data/model-config.json');
      return c.json(config);
    } catch (err) {
      log.error(err, 'Failed to load model config');
      return c.json({ error: 'Failed to load model config' }, 500);
    }
  });

  app.put('/api/model/config', async (c) => {
    try {
      const config = await c.req.json<ProviderConfig>();

      // Validate provider
      if (!['claude', 'ollama'].includes(config.provider)) {
        return c.json({ error: 'Invalid provider. Must be "claude" or "ollama"' }, 400);
      }

      // Validate provider-specific config
      if (config.provider === 'ollama') {
        if (!config.ollama?.baseUrl || !config.ollama?.model) {
          return c.json({ error: 'Ollama config requires baseUrl and model' }, 400);
        }
      }

      if (config.provider === 'claude') {
        if (!config.claude?.model) {
          return c.json({ error: 'Claude config requires model' }, 400);
        }
      }

      // Write config to file
      await writeFile('/data/model-config.json', JSON.stringify(config, null, 2));
      log.info({ provider: config.provider }, 'Model config updated');

      return c.json({ success: true, config });
    } catch (err) {
      log.error(err, 'Failed to update model config');
      return c.json({ error: 'Failed to update model config' }, 500);
    }
  });

  app.get('/api/model/ollama/list', async (c) => {
    try {
      const baseUrl = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';

      const response = await fetch(`${baseUrl}/api/tags`);
      if (!response.ok) {
        return new Response(
          JSON.stringify({ error: `Ollama API error (${response.status})` }),
          {
            status: response.status,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }

      const data = await response.json() as { models: Array<{ name: string; size: number; modified_at: string }> };

      return c.json({
        baseUrl,
        models: data.models.map((m) => ({
          name: m.name,
          size: m.size,
          modifiedAt: m.modified_at,
        })),
      });
    } catch (err) {
      log.error(err, 'Failed to list Ollama models');
      const msg = err instanceof Error ? err.message : 'Failed to list Ollama models';
      return c.json({ error: msg }, 500);
    }
  });

  // Chat endpoint (used by gateway)
  app.post('/api/chat', async (c) => {
    const body = await c.req.json<{
      message: string;
      sessionKey?: string;
      channelType?: string;
      channelId?: string;
      agentId?: string;
    }>();

    const channel = {
      type: (body.channelType ?? 'api') as 'api' | 'gateway' | 'dashboard',
      id: body.channelId ?? 'api',
    };

    if (
      deps.pairingService?.isRequired(channel.type)
      && !deps.pairingService.isPaired(channel.type)
    ) {
      return c.json({
        error: `Channel "${channel.type}" is not paired`,
        pairingRequired: true,
        channelType: channel.type,
      }, 403);
    }

    const targetAgent = deps.agentRegistry?.resolve(body.agentId) ?? deps.agent;

    try {
      const response = await targetAgent.chat(
        body.message,
        channel,
        body.sessionKey
      );

      // Gateway expects NDJSON stream
      if (channel.type === 'gateway') {
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(controller) {
            try {
              controller.enqueue(encoder.encode(JSON.stringify({ kind: 'final', text: response }) + '\n'));
              controller.close();
            } catch (err) {
              controller.error(err);
            }
          }
        });
        return new Response(stream, {
          headers: { 'Content-Type': 'application/x-ndjson' }
        });
      }

      return c.json({ response });
    } catch (err) {
      log.error(err, 'Chat failed');
      const errorMessage = err instanceof Error ? err.message : 'Unknown error occurred';

      // Gateway expects NDJSON stream for errors too
      if (channel.type === 'gateway') {
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(controller) {
            try {
              controller.enqueue(encoder.encode(JSON.stringify({ kind: 'error', message: errorMessage }) + '\n'));
              controller.close();
            } catch (e) {
              controller.error(e);
            }
          }
        });
        return new Response(stream, {
          headers: { 'Content-Type': 'application/x-ndjson' },
          status: 500
        });
      }

      return c.json({ error: errorMessage }, 500);
    }
  });

  // Streaming chat endpoint (SSE)
  app.post('/api/chat/stream', async (c) => {
    const body = await c.req.json<{
      message: string;
      sessionKey?: string;
      channelType?: string;
      channelId?: string;
      agentId?: string;
    }>();

    const channel = {
      type: (body.channelType ?? 'dashboard') as 'api' | 'gateway' | 'dashboard',
      id: body.channelId ?? 'dashboard',
    };

    if (
      deps.pairingService?.isRequired(channel.type)
      && !deps.pairingService.isPaired(channel.type)
    ) {
      return c.json({
        error: `Channel "${channel.type}" is not paired`,
        pairingRequired: true,
        channelType: channel.type,
      }, 403);
    }

    const targetAgent = deps.agentRegistry?.resolve(body.agentId) ?? deps.agent;

    return new Response(
      new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();
          const send = (event: string, data: unknown) => {
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          };

          send('thinking', { status: 'thinking' });

          try {
            const response = await targetAgent.chat(
              body.message,
              channel,
              body.sessionKey,
            );
            send('message', { content: response });
            send('done', { status: 'done' });
          } catch (err) {
            let msg: string;
            if (err instanceof Error) {
              msg = err.name === 'AbortError' ? 'Response was aborted' : err.message;
            } else {
              msg = 'Unknown error occurred';
            }
            log.error(err, 'Stream chat failed');
            send('error', { error: msg });
          } finally {
            controller.close();
          }
        },
      }),
      {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      },
    );
  });

  // Abort current execution
  app.post('/api/chat/abort', async (c) => {
    const { sessionKey } = await c.req.json<{ sessionKey: string }>();
    const aborted = deps.agent.abort(sessionKey);
    return c.json({ aborted });
  });

  // Reset session
  app.post('/api/chat/reset', async (c) => {
    const { sessionKey } = await c.req.json<{ sessionKey: string }>();
    deps.agent.resetSession(sessionKey);
    return c.json({ success: true });
  });

  // Memory search
  app.get('/api/memory', async (c) => {
    const query = c.req.query('q');
    if (!query) {
      return c.json({ error: 'Missing query parameter "q"' }, 400);
    }

    const results = await deps.retriever.retrieve(
      query,
      Number(c.req.query('limit') ?? 10)
    );

    return c.json({
      count: results.length,
      memories: results.map((r) => ({
        ...r.memory,
        score: r.score,
      })),
    });
  });

  app.get('/api/memory/latest', async (c) => {
    const limit = Number(c.req.query('limit') ?? 5);
    const memories = await deps.memory.latest(limit);
    return c.json({ count: memories.length, memories });
  });

  app.get('/api/memory/graph', async (c) => {
    const limit = Math.min(Number(c.req.query('limit') ?? 60), 150);
    const threshold = Math.max(0, Math.min(1, Number(c.req.query('threshold') ?? 0.6)));

    const items = await deps.memory.allWithVectors(limit);

    const nodes = items.map(({ memory }) => ({
      id: memory.id,
      category: memory.category,
      content: memory.content,
      createdAt: memory.createdAt,
    }));

    // Compute pairwise cosine similarity and build edges above threshold
    const edges: Array<{ source: string; target: string; weight: number }> = [];

    for (let i = 0; i < items.length; i++) {
      const va = items[i].vector;
      for (let j = i + 1; j < items.length; j++) {
        const vb = items[j].vector;
        let dot = 0, na = 0, nb = 0;
        for (let k = 0; k < va.length; k++) {
          dot += va[k] * vb[k];
          na += va[k] * va[k];
          nb += vb[k] * vb[k];
        }
        const sim = dot / (Math.sqrt(na) * Math.sqrt(nb));
        if (sim >= threshold) {
          edges.push({ source: items[i].memory.id, target: items[j].memory.id, weight: sim });
        }
      }
    }

    return c.json({ nodes, edges });
  });

  // Conversations (in-memory)
  app.get('/api/conversations', (c) => {
    return c.json(deps.agent.getConversations());
  });

  // Conversation history (database)
  app.get('/api/conversations/history', (c) => {
    if (!deps.database) return c.json({ error: 'Database not available' }, 503);
    const limit = Number(c.req.query('limit') ?? 50);
    return c.json(deps.database.listConversations(limit));
  });

  app.get('/api/conversations/history/:id', (c) => {
    if (!deps.database) return c.json({ error: 'Database not available' }, 503);
    const id = c.req.param('id');
    const messages = deps.database.getConversationMessages(id);
    return c.json({ id, messages });
  });

  // Audit log
  app.get('/api/audit', (c) => {
    if (!deps.database) {
      // Fallback to in-memory if database not available
      const limit = Number(c.req.query('limit') ?? 50);
      return c.json(deps.agent.audit.slice(-limit));
    }

    const limit = Number(c.req.query('limit') ?? 100);
    const offset = Number(c.req.query('offset') ?? 0);

    const action = c.req.query('action') || undefined;
    const logType = c.req.query('logType') || undefined;
    const from = c.req.query('from') || undefined;
    const to = c.req.query('to') || undefined;
    const sessionKey = c.req.query('sessionKey') || undefined;

    const logs = deps.database.getAuditLogs({ limit, offset, action, logType, from, to, sessionKey });
    const total = deps.database.getAuditCount({ action, logType, from, to, sessionKey });

    return c.json({
      logs,
      total,
      limit,
      offset,
    });
  });

  app.post('/api/audit/scrub', async (c) => {
    if (!deps.database) {
      return c.json({ error: 'Database not available' }, 503);
    }

    const rawBody: unknown = await c.req.json().catch(() => ({}));
    const body = (rawBody && typeof rawBody === 'object') ? rawBody as { dryRun?: unknown; limit?: unknown } : {};
    const dryRun = typeof body.dryRun === 'boolean' ? body.dryRun : false;
    const limit = typeof body.limit === 'number' ? Math.max(1, Math.min(5000, body.limit)) : undefined;

    const result = deps.database.scrubAuditLog({ dryRun, limit });
    return c.json({
      success: true,
      dryRun,
      limit: limit ?? 1000,
      ...result,
    });
  });

  // --- Task scheduler endpoints ---

  app.get('/api/tasks', (c) => {
    if (!deps.scheduler) return c.json({ error: 'Scheduler not available' }, 503);
    return c.json(deps.scheduler.list());
  });

  app.post('/api/tasks', async (c) => {
    if (!deps.scheduler) return c.json({ error: 'Scheduler not available' }, 503);
    const body = await c.req.json<{
      name: string;
      cron: string;
      prompt: string;
      targetChannel?: { type: string; id: string };
    }>();
    if (!body.name || !body.cron || !body.prompt) {
      return c.json({ error: 'Missing required fields: name, cron, prompt' }, 400);
    }
    try {
      const task = await deps.scheduler.add(body);
      return c.json(task, 201);
    } catch (err) {
      log.error(err, 'Failed to create task');
      return c.json({ error: 'Failed to create task' }, 500);
    }
  });

  app.put('/api/tasks/:id', async (c) => {
    if (!deps.scheduler) return c.json({ error: 'Scheduler not available' }, 503);
    const id = c.req.param('id');
    const changes = await c.req.json();
    const task = await deps.scheduler.update(id, changes);
    if (!task) return c.json({ error: 'Task not found' }, 404);
    return c.json(task);
  });

  app.delete('/api/tasks/:id', async (c) => {
    if (!deps.scheduler) return c.json({ error: 'Scheduler not available' }, 503);
    const id = c.req.param('id');
    const removed = await deps.scheduler.remove(id);
    if (!removed) return c.json({ error: 'Task not found' }, 404);
    return c.json({ success: true });
  });

  app.post('/api/tasks/:id/run', async (c) => {
    if (!deps.scheduler) return c.json({ error: 'Scheduler not available' }, 503);
    const id = c.req.param('id');
    try {
      const jobId = await deps.scheduler.runNow(id);
      if (jobId === null) return c.json({ error: 'Task not found' }, 404);
      return c.json({ jobId, message: `Task dispatched as background job ${jobId}` });
    } catch (err) {
      log.error(err, 'Manual task run failed');
      return c.json({ error: 'Task execution failed' }, 500);
    }
  });

  // --- Background job endpoints ---

  app.get('/api/jobs', (c) => {
    if (!deps.jobManager) return c.json({ error: 'Job manager not available' }, 503);
    const limit = Number(c.req.query('limit') ?? 50);
    const status = c.req.query('status') as string | undefined;
    let jobs = deps.jobManager.list();
    if (status) {
      jobs = jobs.filter((j) => j.status === status);
    }
    return c.json(jobs.slice(-Math.min(limit, 200)));
  });

  app.post('/api/jobs', async (c) => {
    if (!deps.jobManager) return c.json({ error: 'Job manager not available' }, 503);
    const body = await c.req.json<{
      name: string;
      prompt: string;
      targetChannel?: { type: string; id: string };
      timeoutMs?: number;
    }>();
    if (!body.name || !body.prompt) {
      return c.json({ error: 'Missing required fields: name, prompt' }, 400);
    }
    try {
      const job = await deps.jobManager.spawn(body);
      return c.json(job, 202);
    } catch (err) {
      log.error(err, 'Failed to spawn background job');
      return c.json({ error: 'Failed to spawn job' }, 500);
    }
  });

  app.get('/api/jobs/:id', (c) => {
    if (!deps.jobManager) return c.json({ error: 'Job manager not available' }, 503);
    const id = c.req.param('id');
    const job = deps.jobManager.get(id);
    if (!job) return c.json({ error: 'Job not found' }, 404);
    return c.json(job);
  });

  app.delete('/api/jobs/:id', async (c) => {
    if (!deps.jobManager) return c.json({ error: 'Job manager not available' }, 503);
    const id = c.req.param('id');
    // Try cancel first (running/queued jobs), then dismiss (terminal jobs)
    const cancelled = await deps.jobManager.cancel(id);
    if (cancelled) return c.json({ success: true, action: 'cancelled' });
    const dismissed = await deps.jobManager.dismiss(id);
    if (dismissed) return c.json({ success: true, action: 'dismissed' });
    return c.json({ error: 'Job not found' }, 404);
  });

  // --- Skill endpoints ---

  app.get('/api/skills', (c) => {
    if (!deps.skillRegistry) return c.json({ error: 'Skills not available' }, 503);
    return c.json(deps.skillRegistry.list());
  });

  app.get('/api/skills/:name', (c) => {
    if (!deps.skillRegistry) return c.json({ error: 'Skills not available' }, 503);
    const name = c.req.param('name');
    const skill = deps.skillRegistry.get(name);
    if (!skill) return c.json({ error: 'Skill not found' }, 404);
    return c.json(skill);
  });

  app.post('/api/skills', async (c) => {
    if (!deps.skillRegistry) return c.json({ error: 'Skills not available' }, 503);
    const body = await c.req.json<{
      dirName: string;
      skillMd: string;
      config?: { requiredSecrets?: string[]; pythonDependencies?: string[]; oauth?: Record<string, { provider: string; scopes: string[] }> };
      toolServerPy?: string;
      requirementsTxt?: string;
    }>();
    if (!body.dirName || !body.skillMd) {
      return c.json({ error: 'Missing required fields: dirName, skillMd' }, 400);
    }
    try {
      const skill = await deps.skillRegistry.create(body);
      return c.json(skill, 201);
    } catch (err) {
      log.error(err, 'Failed to create skill');
      const msg = err instanceof Error ? err.message : 'Failed to create skill';
      return c.json({ error: msg }, 500);
    }
  });

  app.post('/api/skills/:name/enable', async (c) => {
    if (!deps.skillRegistry) return c.json({ error: 'Skills not available' }, 503);
    const name = c.req.param('name');
    const ok = await deps.skillRegistry.enable(name);
    if (!ok) return c.json({ error: 'Skill not found' }, 404);
    return c.json({ success: true });
  });

  app.post('/api/skills/:name/disable', async (c) => {
    if (!deps.skillRegistry) return c.json({ error: 'Skills not available' }, 503);
    const name = c.req.param('name');
    const ok = await deps.skillRegistry.disable(name);
    if (!ok) return c.json({ error: 'Skill not found' }, 404);
    return c.json({ success: true });
  });

  app.put('/api/skills/:name/values', async (c) => {
    if (!deps.skillRegistry) return c.json({ error: 'Skills not available' }, 503);
    const name = c.req.param('name');
    const { key, value } = await c.req.json<{ key: string; value: string }>();
    if (!key || !value) return c.json({ error: 'Missing key or value' }, 400);
    const ok = await deps.skillRegistry.setSkillValue(name, key, value);
    if (!ok) return c.json({ error: 'Skill not found' }, 404);
    return c.json({ success: true });
  });

  app.delete('/api/skills/:name/values/:key', async (c) => {
    if (!deps.skillRegistry) return c.json({ error: 'Skills not available' }, 503);
    const name = c.req.param('name');
    const key = c.req.param('key');
    const ok = await deps.skillRegistry.removeSkillValue(name, key);
    if (!ok) return c.json({ error: 'Skill not found' }, 404);
    return c.json({ success: true });
  });

  app.get('/api/skills/:name/config', (c) => {
    if (!deps.skillRegistry) return c.json({ error: 'Skills not available' }, 503);
    const name = c.req.param('name');
    const config = deps.skillRegistry.getConfig(name);
    if (config === null) return c.json({ error: 'Skill not found' }, 404);
    return c.json(config);
  });

  app.put('/api/skills/:name/config', async (c) => {
    if (!deps.skillRegistry) return c.json({ error: 'Skills not available' }, 503);
    const name = c.req.param('name');
    const config = await c.req.json();
    const ok = await deps.skillRegistry.updateConfig(name, config);
    if (!ok) return c.json({ error: 'Skill not found' }, 404);
    return c.json({ success: true });
  });

  app.delete('/api/skills/:name', async (c) => {
    if (!deps.skillRegistry) return c.json({ error: 'Skills not available' }, 503);
    const name = c.req.param('name');
    const ok = await deps.skillRegistry.delete(name);
    if (!ok) return c.json({ error: 'Skill not found' }, 404);
    return c.json({ success: true });
  });

  app.get('/api/skills/:name/export', async (c) => {
    if (!deps.skillRegistry) return c.json({ error: 'Skills not available' }, 503);
    const name = c.req.param('name');
    const zipBuffer = await deps.skillRegistry.exportSkill(name);
    if (!zipBuffer) return c.json({ error: 'Skill not found' }, 404);

    const filename = `${name}.zip`;
    return new Response(zipBuffer, {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  });

  app.post('/api/skills/import', async (c) => {
    if (!deps.skillRegistry) return c.json({ error: 'Skills not available' }, 503);

    try {
      const body = await c.req.parseBody();
      const file = body.file;

      if (!file || typeof file === 'string') {
        return c.json({ error: 'No file uploaded' }, 400);
      }

      // Read file buffer
      const arrayBuffer = await file.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      const overwrite = body.overwrite === 'true';
      const skill = await deps.skillRegistry.importSkill(buffer, overwrite);

      return c.json({ success: true, skill }, 201);
    } catch (err) {
      log.error(err, 'Failed to import skill');
      const msg = err instanceof Error ? err.message : 'Failed to import skill';
      return c.json({ error: msg }, 400);
    }
  });

  // Import a skill from a raw SKILL.md / skill.md string (Claude Code format)
  app.post('/api/skills/import-claude-md', async (c) => {
    if (!deps.skillRegistry) return c.json({ error: 'Skills not available' }, 503);
    try {
      const body = await c.req.parseBody();
      const file = body.file;
      if (!file || typeof file === 'string') return c.json({ error: 'No file uploaded' }, 400);
      const content = await (file as File).text();
      const overwrite = body.overwrite === 'true';
      const skill = await deps.skillRegistry.importFromMarkdown(content, overwrite);
      return c.json({ success: true, skill }, 201);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Import failed';
      return c.json({ error: msg }, 400);
    }
  });

  // Export a skill as a Claude Code-compatible SKILL.md file
  app.get('/api/skills/:name/export-claude', (c) => {
    if (!deps.skillRegistry) return c.json({ error: 'Skills not available' }, 503);
    const name = c.req.param('name');
    const content = deps.skillRegistry.exportAsClaudeSkillMd(name);
    if (!content) return c.json({ error: 'Skill not found' }, 404);

    return new Response(content, {
      status: 200,
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="SKILL.md"`,
      },
    });
  });

  // Sync skills from a mounted Claude Code skills directory (CLAUDE_SKILLS_PATH env)
  app.post('/api/skills/sync-claude', async (c) => {
    if (!deps.skillRegistry) return c.json({ error: 'Skills not available' }, 503);
    const claudeSkillsPath = process.env.CLAUDE_SKILLS_PATH;
    if (!claudeSkillsPath) {
      return c.json({ error: 'CLAUDE_SKILLS_PATH is not configured' }, 400);
    }
    try {
      const result = await deps.skillRegistry.syncFromClaudeSkillsDir(claudeSkillsPath);
      return c.json({ success: true, ...result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Sync failed';
      return c.json({ error: msg }, 400);
    }
  });

  // --- Channel endpoints ---

  app.get('/api/channels', (c) => {
    if (!deps.channelRegistry) return c.json({ error: 'Channels not available' }, 503);
    return c.json(deps.channelRegistry.list());
  });

  app.get('/api/channels/:name', (c) => {
    if (!deps.channelRegistry) return c.json({ error: 'Channels not available' }, 503);
    const name = c.req.param('name');
    const channel = deps.channelRegistry.get(name);
    if (!channel) return c.json({ error: 'Channel not found' }, 404);
    return c.json(channel);
  });

  app.post('/api/channels', async (c) => {
    if (!deps.channelRegistry) return c.json({ error: 'Channels not available' }, 503);
    try {
      const { dirName, metadata, config } = await c.req.json();
      const channel = await deps.channelRegistry.create(dirName, metadata, config);
      return c.json(channel, 201);
    } catch (err) {
      log.error(err, 'Failed to create channel');
      const msg = err instanceof Error ? err.message : 'Failed to create channel';
      return c.json({ error: msg }, 400);
    }
  });

  app.post('/api/channels/:name/enable', async (c) => {
    if (!deps.channelRegistry) return c.json({ error: 'Channels not available' }, 503);
    const name = c.req.param('name');
    await deps.channelRegistry.enable(name);
    return c.json({ success: true });
  });

  app.post('/api/channels/:name/disable', async (c) => {
    if (!deps.channelRegistry) return c.json({ error: 'Channels not available' }, 503);
    const name = c.req.param('name');
    await deps.channelRegistry.disable(name);
    return c.json({ success: true });
  });

  app.post('/api/channels/:name/start', async (c) => {
    if (!deps.channelRegistry) return c.json({ error: 'Channels not available' }, 503);
    const name = c.req.param('name');
    try {
      await deps.channelRegistry.startChannel(name);
      return c.json({ success: true });
    } catch (err) {
      log.error(err, 'Failed to start channel');
      const msg = err instanceof Error ? err.message : 'Failed to start channel';
      return c.json({ error: msg }, 500);
    }
  });

  app.post('/api/channels/:name/stop', async (c) => {
    if (!deps.channelRegistry) return c.json({ error: 'Channels not available' }, 503);
    const name = c.req.param('name');
    try {
      await deps.channelRegistry.stopChannel(name);
      return c.json({ success: true });
    } catch (err) {
      log.error(err, 'Failed to stop channel');
      const msg = err instanceof Error ? err.message : 'Failed to stop channel';
      return c.json({ error: msg }, 500);
    }
  });

  app.put('/api/channels/:name/values', async (c) => {
    if (!deps.channelRegistry) return c.json({ error: 'Channels not available' }, 503);
    const name = c.req.param('name');
    const { key, value } = await c.req.json();
    await deps.channelRegistry.setChannelValue(name, key, value);
    return c.json({ success: true });
  });

  app.delete('/api/channels/:name/values/:key', async (c) => {
    if (!deps.channelRegistry) return c.json({ error: 'Channels not available' }, 503);
    const name = c.req.param('name');
    const key = c.req.param('key');
    await deps.channelRegistry.deleteChannelValue(name, key);
    return c.json({ success: true });
  });

  app.put('/api/channels/:name/config', async (c) => {
    if (!deps.channelRegistry) return c.json({ error: 'Channels not available' }, 503);
    const name = c.req.param('name');
    try {
      const config = await c.req.json();
      const updated = await deps.channelRegistry.updateConfig(name, config);
      if (!updated) return c.json({ error: 'Channel not found' }, 404);
      return c.json({ success: true });
    } catch (err) {
      log.error(err, 'Failed to update channel config');
      const msg = err instanceof Error ? err.message : 'Failed to update config';
      return c.json({ error: msg }, 500);
    }
  });

  app.delete('/api/channels/:name', async (c) => {
    if (!deps.channelRegistry) return c.json({ error: 'Channels not available' }, 503);
    const name = c.req.param('name');
    try {
      await deps.channelRegistry.delete(name);
      return c.json({ success: true });
    } catch (err) {
      log.error(err, 'Failed to delete channel');
      const msg = err instanceof Error ? err.message : 'Failed to delete channel';
      return c.json({ error: msg }, 500);
    }
  });

  app.get('/api/channels/:name/export', async (c) => {
    if (!deps.channelRegistry) return c.json({ error: 'Channels not available' }, 503);
    const name = c.req.param('name');
    const zipBuffer = await deps.channelRegistry.exportChannel(name);
    if (!zipBuffer) return c.json({ error: 'Channel not found' }, 404);

    const filename = `${name}.zip`;
    return new Response(zipBuffer, {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  });

  app.post('/api/channels/import', async (c) => {
    if (!deps.channelRegistry) return c.json({ error: 'Channels not available' }, 503);

    try {
      const body = await c.req.parseBody();
      const file = body.file;

      if (!file || typeof file === 'string') {
        return c.json({ error: 'No file uploaded' }, 400);
      }

      // Read file buffer
      const arrayBuffer = await file.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      const overwrite = body.overwrite === 'true';
      const channel = await deps.channelRegistry.importChannel(buffer, overwrite);

      return c.json({ success: true, channel }, 201);
    } catch (err) {
      log.error(err, 'Failed to import channel');
      const msg = err instanceof Error ? err.message : 'Failed to import channel';
      return c.json({ error: msg }, 400);
    }
  });

  app.post('/api/channels/:name/send', async (c) => {
    if (!deps.channelRegistry) return c.json({ error: 'Channels not available' }, 503);
    const name = c.req.param('name');
    try {
      const { channelId, text } = await c.req.json();
      await deps.channelRegistry.sendMessage(name, channelId, text);
      return c.json({ success: true });
    } catch (err) {
      log.error(err, 'Failed to send message');
      const msg = err instanceof Error ? err.message : 'Failed to send message';
      return c.json({ error: msg }, 500);
    }
  });

  app.post('/api/channels/:name/webhook', async (c) => {
    if (!deps.channelRegistry) return c.json({ error: 'Channels not available' }, 503);
    const name = c.req.param('name');
    try {
      const body = await c.req.json();
      await deps.channelRegistry.handleWebhook(name, body);
      return c.json({ ok: true });
    } catch (err) {
      log.error(err, 'Failed to handle webhook');
      const msg = err instanceof Error ? err.message : 'Webhook handling failed';
      return c.json({ error: msg }, 500);
    }
  });

  // --- OAuth provider endpoints ---

  app.get('/api/oauth/providers', (c) => {
    if (!deps.oauthProviderStore) return c.json({ error: 'OAuth not available' }, 503);
    return c.json(deps.oauthProviderStore.list());
  });

  app.put('/api/oauth/providers/:id', async (c) => {
    if (!deps.oauthProviderStore) return c.json({ error: 'OAuth not available' }, 503);
    const id = c.req.param('id');
    const body = await c.req.json<{
      name: string;
      authEndpoint: string;
      tokenEndpoint: string;
      clientId: string;
      clientSecret?: string;
    }>();
    if (!body.name || !body.clientId) {
      return c.json({ error: 'Missing required fields' }, 400);
    }
    // Preserve existing secret if not provided
    const existing = deps.oauthProviderStore.get(id);
    const clientSecret = body.clientSecret || existing?.clientSecret || '';
    if (!clientSecret) {
      return c.json({ error: 'Client secret is required for new providers' }, 400);
    }
    await deps.oauthProviderStore.upsert({
      id,
      name: body.name,
      authEndpoint: body.authEndpoint,
      tokenEndpoint: body.tokenEndpoint,
      clientId: body.clientId,
      clientSecret,
    });
    return c.json({ success: true });
  });

  app.delete('/api/oauth/providers/:id', async (c) => {
    if (!deps.oauthProviderStore) return c.json({ error: 'OAuth not available' }, 503);
    const id = c.req.param('id');
    const ok = await deps.oauthProviderStore.remove(id);
    if (!ok) return c.json({ error: 'Provider not found' }, 404);
    return c.json({ success: true });
  });

  app.post('/api/oauth/authorize', async (c) => {
    if (!deps.oauthHandler) return c.json({ error: 'OAuth not available' }, 503);
    const body = await c.req.json<{
      provider: string;
      skillDirName: string;
      secretKey: string;
      scopes: string[];
      entityType?: 'skill' | 'channel';
    }>();
    try {
      const result = await deps.oauthHandler.authorize(body);
      return c.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Authorization failed';
      return c.json({ error: msg }, 400);
    }
  });

  // GET-friendly authorize URL (for clickable links from chat)
  app.get('/api/oauth/authorize-url', async (c) => {
    if (!deps.oauthHandler) return c.json({ error: 'OAuth not available' }, 503);
    const provider = c.req.query('provider');
    const skillDirName = c.req.query('skillDirName');
    const secretKey = c.req.query('secretKey');
    const scopes = c.req.query('scopes');
    const entityType = (c.req.query('entityType') ?? 'skill') as 'skill' | 'channel';
    if (!provider || !skillDirName || !secretKey) {
      return c.json({ error: 'Missing required query params: provider, skillDirName, secretKey' }, 400);
    }
    try {
      const result = await deps.oauthHandler.authorize({
        provider,
        skillDirName,
        secretKey,
        scopes: scopes?.split(',').map((s) => s.trim()).filter(Boolean) ?? [],
        entityType,
      });
      return c.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Authorization failed';
      return c.json({ error: msg }, 400);
    }
  });

  app.post('/api/oauth/exchange', async (c) => {
    if (!deps.oauthHandler) return c.json({ error: 'OAuth not available' }, 503);
    const body = await c.req.json<{ code: string; state: string }>();
    try {
      const result = await deps.oauthHandler.exchange(body);
      return c.json(result);
    } catch (err) {
      log.error(err, 'OAuth exchange failed');
      const msg = err instanceof Error ? err.message : 'Exchange failed';
      return c.json({ error: msg }, 400);
    }
  });

  // --- Connections overview ---

  app.get('/api/connections', async (c) => {
    if (!deps.skillRegistry) return c.json({ error: 'Skills not available' }, 503);
    const connections = deps.skillRegistry.getConnections();

    if (!deps.connectionManager) {
      return c.json(connections);
    }

    // Enrich with expiry info
    const entities = [
      ...deps.skillRegistry.list()
        .filter((s) => s.config?.oauth)
        .flatMap((s) =>
          Object.entries(s.config!.oauth!).map(([secretKey, flowConfig]) => ({
            dir: s.filePath,
            name: s.metadata.name,
            secretKey,
            oauth: s.config!.oauth,
            provider: flowConfig.provider,
          }))
        ),
      ...(deps.channelRegistry?.list() ?? [])
        .filter((ch) => ch.config?.oauth)
        .flatMap((ch) =>
          Object.entries(ch.config!.oauth!).map(([secretKey, flowConfig]) => ({
            dir: ch.filePath,
            name: ch.metadata.name,
            secretKey,
            oauth: ch.config!.oauth,
            provider: flowConfig.provider,
          }))
        ),
    ];

    const statuses = await deps.connectionManager.getConnectionStatus(entities);
    return c.json({ skillConnections: connections, connectionStatus: statuses });
  });

  // --- Inline per-skill OAuth credentials ---

  app.put('/api/skills/:name/oauth-provider/:key', async (c) => {
    if (!deps.skillRegistry) return c.json({ error: 'Skills not available' }, 503);
    const name = c.req.param('name');
    const key = c.req.param('key');
    const { clientId, clientSecret } = await c.req.json<{ clientId: string; clientSecret: string }>();
    if (!clientId || !clientSecret) return c.json({ error: 'Missing clientId or clientSecret' }, 400);
    const ok = await deps.skillRegistry.setOAuthCredentials(name, key, clientId, clientSecret);
    if (!ok) return c.json({ error: 'Skill not found' }, 404);
    return c.json({ success: true });
  });

  app.put('/api/skills/:name/source', async (c) => {
    if (!deps.skillRegistry) return c.json({ error: 'Skills not available' }, 503);
    const name = c.req.param('name');
    const body = await c.req.json<{ skillMd?: string; toolServerPy?: string; requirementsTxt?: string }>();
    try {
      const ok = await deps.skillRegistry.updateSource(name, body);
      if (!ok) return c.json({ error: 'Skill not found' }, 404);
      return c.json({ success: true });
    } catch (err) {
      log.error(err, 'Failed to update skill source');
      const msg = err instanceof Error ? err.message : 'Failed to update skill source';
      return c.json({ error: msg }, 500);
    }
  });

  // --- Channel OAuth endpoints ---

  app.put('/api/channels/:name/oauth-provider/:key', async (c) => {
    if (!deps.channelRegistry) return c.json({ error: 'Channels not available' }, 503);
    const name = c.req.param('name');
    const key = c.req.param('key');
    const { clientId, clientSecret } = await c.req.json<{ clientId: string; clientSecret: string }>();
    if (!clientId || !clientSecret) return c.json({ error: 'Missing clientId or clientSecret' }, 400);
    const ok = await deps.channelRegistry.setOAuthCredentials(name, key, clientId, clientSecret);
    if (!ok) return c.json({ error: 'Channel not found' }, 404);
    return c.json({ success: true });
  });

  app.put('/api/channels/:name/source', async (c) => {
    if (!deps.channelRegistry) return c.json({ error: 'Channels not available' }, 503);
    const name = c.req.param('name');
    const body = await c.req.json<{ channelMd?: string; handlerJs?: string }>();
    try {
      const ok = await deps.channelRegistry.updateSource(name, body);
      if (!ok) return c.json({ error: 'Channel not found' }, 404);
      return c.json({ success: true });
    } catch (err) {
      log.error(err, 'Failed to update channel source');
      const msg = err instanceof Error ? err.message : 'Failed to update channel source';
      return c.json({ error: msg }, 500);
    }
  });

  // --- Agent management endpoints ---

  app.get('/api/agents', (c) => {
    if (!deps.agentRegistry) return c.json({ error: 'Agent registry not available' }, 503);
    return c.json({ agents: deps.agentRegistry.list() });
  });

  app.post('/api/agents', async (c) => {
    if (!deps.agentRegistry) return c.json({ error: 'Agent registry not available' }, 503);
    try {
      const body = await c.req.json<{
        name: string;
        description?: string;
        provider: 'claude' | 'ollama';
        claudeModel?: string;
        ollamaBaseUrl?: string;
        ollamaModel?: string;
        systemPromptOverride?: string;
        isDefault?: boolean;
        enabled?: boolean;
      }>();
      if (!body.name || !body.provider) {
        return c.json({ error: 'Missing required fields: name, provider' }, 400);
      }
      if (!['claude', 'ollama'].includes(body.provider)) {
        return c.json({ error: 'Invalid provider. Must be "claude" or "ollama"' }, 400);
      }
      const row = await deps.agentRegistry.addAgent(body);
      return c.json(row, 201);
    } catch (err) {
      log.error(err, 'Failed to create agent');
      const msg = err instanceof Error ? err.message : 'Failed to create agent';
      return c.json({ error: msg }, 400);
    }
  });

  app.get('/api/agents/:id', (c) => {
    if (!deps.agentRegistry) return c.json({ error: 'Agent registry not available' }, 503);
    const id = c.req.param('id');
    const items = deps.agentRegistry.list();
    const item = items.find((a) => a.row.id === id);
    if (!item) return c.json({ error: 'Agent not found' }, 404);
    return c.json(item);
  });

  app.put('/api/agents/:id', async (c) => {
    if (!deps.agentRegistry) return c.json({ error: 'Agent registry not available' }, 503);
    const id = c.req.param('id');
    try {
      const updates = await c.req.json<Partial<{
        name: string;
        description: string;
        provider: 'claude' | 'ollama';
        claudeModel: string;
        ollamaBaseUrl: string;
        ollamaModel: string;
        systemPromptOverride: string;
        isDefault: boolean;
        enabled: boolean;
      }>>();
      const row = await deps.agentRegistry.updateAgent(id, updates);
      return c.json(row);
    } catch (err) {
      log.error(err, 'Failed to update agent');
      const msg = err instanceof Error ? err.message : 'Failed to update agent';
      return c.json({ error: msg }, 400);
    }
  });

  app.delete('/api/agents/:id', async (c) => {
    if (!deps.agentRegistry) return c.json({ error: 'Agent registry not available' }, 503);
    const id = c.req.param('id');
    try {
      await deps.agentRegistry.deleteAgent(id);
      return c.json({ success: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to delete agent';
      return c.json({ error: msg }, 400);
    }
  });

  app.post('/api/agents/:id/set-default', async (c) => {
    if (!deps.agentRegistry) return c.json({ error: 'Agent registry not available' }, 503);
    const id = c.req.param('id');
    try {
      await deps.agentRegistry.setDefault(id);
      return c.json({ success: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to set default agent';
      return c.json({ error: msg }, 400);
    }
  });

  app.get('/api/agents/:id/status', (c) => {
    if (!deps.agentRegistry) return c.json({ error: 'Agent registry not available' }, 503);
    const id = c.req.param('id');
    const core = deps.agentRegistry.getById(id);
    if (!core) return c.json({ error: 'Agent not found or not active' }, 404);
    return c.json({
      id,
      providerName: core.getProviderName(),
      uptime: core.uptime,
      activeConversations: core.activeConversationCount,
    });
  });

  return app;
}
