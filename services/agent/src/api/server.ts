import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createLogger } from '@jonas/shared/utils';
import type { AgentCore } from '../agent/core.js';
import type { MemoryClient } from '../memory/client.js';
import type { MemoryRetriever } from '../memory/retriever.js';
import type { TaskScheduler } from '../tasks/scheduler.js';
import type { SkillRegistry } from '../skills/registry.js';
import type { OAuthProviderStore } from '../oauth/provider-store.js';
import type { OAuthHandler } from '../oauth/handler.js';

const log = createLogger('api');

interface ApiDeps {
  agent: AgentCore;
  memory: MemoryClient;
  retriever: MemoryRetriever;
  scheduler?: TaskScheduler;
  skillRegistry?: SkillRegistry;
  oauthProviderStore?: OAuthProviderStore;
  oauthHandler?: OAuthHandler;
}

export function createApiServer(deps: ApiDeps) {
  const app = new Hono();

  app.use('*', cors({ origin: '*' }));

  // Health / status
  app.get('/api/status', async (c) => {
    const [episodic, semantic, procedural] = await Promise.all([
      deps.memory.count('episodic'),
      deps.memory.count('semantic'),
      deps.memory.count('procedural'),
    ]);

    return c.json({
      uptime: deps.agent.uptime,
      model: process.env.AGENT_DEFAULT_MODEL ?? 'claude-sonnet-4-5-20250929',
      memoryStats: { episodic, semantic, procedural },
      activeConversations: deps.agent.activeConversationCount,
      skillCount: deps.skillRegistry?.list().length ?? 0,
      channels: {
        dashboard: true,
        gateway: true,
      },
    });
  });

  // Chat endpoint (used by gateway)
  app.post('/api/chat', async (c) => {
    const body = await c.req.json<{
      message: string;
      sessionKey?: string;
      channelType?: string;
      channelId?: string;
    }>();

    const channel = {
      type: (body.channelType ?? 'api') as 'api' | 'gateway' | 'dashboard',
      id: body.channelId ?? 'api',
    };

    try {
      const response = await deps.agent.chat(
        body.message,
        channel,
        body.sessionKey
      );
      return c.json({ response });
    } catch (err) {
      log.error(err, 'Chat failed');
      return c.json({ error: 'Chat failed' }, 500);
    }
  });

  // Streaming chat endpoint (SSE)
  app.post('/api/chat/stream', async (c) => {
    const body = await c.req.json<{
      message: string;
      sessionKey?: string;
      channelType?: string;
      channelId?: string;
    }>();

    const channel = {
      type: (body.channelType ?? 'dashboard') as 'api' | 'gateway' | 'dashboard',
      id: body.channelId ?? 'dashboard',
    };

    return new Response(
      new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();
          const send = (event: string, data: unknown) => {
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          };

          send('thinking', { status: 'thinking' });

          try {
            const response = await deps.agent.chat(
              body.message,
              channel,
              body.sessionKey,
            );
            send('message', { content: response });
            send('done', { status: 'done' });
          } catch (err) {
            const msg = err instanceof Error && err.name === 'AbortError'
              ? 'Response was aborted'
              : 'Chat failed';
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

  // Conversations
  app.get('/api/conversations', (c) => {
    return c.json(deps.agent.getConversations());
  });

  // Audit log
  app.get('/api/audit', (c) => {
    const limit = Number(c.req.query('limit') ?? 50);
    return c.json(deps.agent.audit.slice(-limit));
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
      const result = await deps.scheduler.runNow(id);
      if (result === null) return c.json({ error: 'Task not found' }, 404);
      return c.json({ result });
    } catch (err) {
      log.error(err, 'Manual task run failed');
      return c.json({ error: 'Task execution failed' }, 500);
    }
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
      config?: { requiredSecrets?: string[]; pythonDependencies?: string[] };
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
    if (!provider || !skillDirName || !secretKey) {
      return c.json({ error: 'Missing required query params: provider, skillDirName, secretKey' }, 400);
    }
    try {
      const result = await deps.oauthHandler.authorize({
        provider,
        skillDirName,
        secretKey,
        scopes: scopes?.split(',').map((s) => s.trim()).filter(Boolean) ?? [],
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

  app.get('/api/connections', (c) => {
    if (!deps.skillRegistry) return c.json({ error: 'Skills not available' }, 503);
    return c.json(deps.skillRegistry.getConnections());
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

  return app;
}
