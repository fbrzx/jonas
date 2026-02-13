import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createLogger } from '@jonas/shared/utils';
import type { AgentCore } from '../agent/core.js';
import type { MemoryClient } from '../memory/client.js';
import type { MemoryRetriever } from '../memory/retriever.js';
import type { TaskScheduler } from '../tasks/scheduler.js';
import type { SkillRegistry } from '../skills/registry.js';

const log = createLogger('api');

interface ApiDeps {
  agent: AgentCore;
  memory: MemoryClient;
  retriever: MemoryRetriever;
  scheduler?: TaskScheduler;
  skillRegistry?: SkillRegistry;
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
        matrix: !!process.env.MATRIX_HOMESERVER,
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
      type: (body.channelType ?? 'api') as 'api' | 'matrix' | 'gateway',
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

  // Abort current execution
  app.post('/api/chat/abort', async (c) => {
    const { sessionKey } = await c.req.json<{ sessionKey: string }>();
    const aborted = deps.agent.abort(sessionKey);
    return c.json({ aborted });
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
      targetRoomId: string;
    }>();
    if (!body.name || !body.cron || !body.prompt || !body.targetRoomId) {
      return c.json({ error: 'Missing required fields: name, cron, prompt, targetRoomId' }, 400);
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

  return app;
}
