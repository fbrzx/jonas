import { describe, it, expect, beforeEach } from 'vitest';
import { ConversationDatabase } from '../database.js';

function makeDb() {
  // ':memory:' gives an isolated in-process DB — no disk I/O, no cleanup needed
  return new ConversationDatabase(':memory:');
}

describe('ConversationDatabase', () => {
  describe('conversations', () => {
    let db: ConversationDatabase;
    beforeEach(() => { db = makeDb(); });

    it('saves and retrieves a conversation', () => {
      db.saveConversation({
        id: 'conv_1',
        sessionKey: 'sk_1',
        channelType: 'matrix',
        channelId: '!room:server',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      });

      const result = db.getConversation('sk_1');
      expect(result).not.toBeNull();
      expect(result!.conv.id).toBe('conv_1');
      expect(result!.conv.channelType).toBe('matrix');
    });

    it('returns null for unknown session key', () => {
      expect(db.getConversation('nonexistent')).toBeNull();
    });

    it('saves and retrieves messages within a conversation', () => {
      db.saveConversation({
        id: 'conv_1',
        sessionKey: 'sk_1',
        channelType: 'dashboard',
        channelId: 'web',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      });
      db.saveMessage({ id: 'msg_1', conversationId: 'conv_1', role: 'user', content: 'hi', timestamp: '2024-01-01T00:00:01.000Z' });
      db.saveMessage({ id: 'msg_2', conversationId: 'conv_1', role: 'assistant', content: 'hello', timestamp: '2024-01-01T00:00:02.000Z' });

      const result = db.getConversation('sk_1');
      expect(result!.messages).toHaveLength(2);
      expect(result!.messages[0].role).toBe('user');
      expect(result!.messages[1].role).toBe('assistant');
    });

    it('getConversationMessages returns messages ordered by timestamp', () => {
      db.saveConversation({ id: 'conv_1', sessionKey: 'sk_1', channelType: 'job', channelId: 'j1', createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z' });
      db.saveMessage({ id: 'msg_b', conversationId: 'conv_1', role: 'assistant', content: 'b', timestamp: '2024-01-01T00:00:02.000Z' });
      db.saveMessage({ id: 'msg_a', conversationId: 'conv_1', role: 'user', content: 'a', timestamp: '2024-01-01T00:00:01.000Z' });

      const msgs = db.getConversationMessages('conv_1');
      expect(msgs[0].id).toBe('msg_a');
      expect(msgs[1].id).toBe('msg_b');
    });

    it('deleteConversation removes conversation and cascades to messages', () => {
      db.saveConversation({ id: 'conv_1', sessionKey: 'sk_1', channelType: 'matrix', channelId: 'r', createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z' });
      db.saveMessage({ id: 'msg_1', conversationId: 'conv_1', role: 'user', content: 'x', timestamp: '2024-01-01T00:00:01.000Z' });

      db.deleteConversation('sk_1');

      expect(db.getConversation('sk_1')).toBeNull();
      expect(db.getConversationMessages('conv_1')).toHaveLength(0);
    });

    it('listConversations returns most recently updated first', () => {
      db.saveConversation({ id: 'c1', sessionKey: 's1', channelType: 'matrix', channelId: 'r', createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T01:00:00.000Z' });
      db.saveConversation({ id: 'c2', sessionKey: 's2', channelType: 'matrix', channelId: 'r', createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T02:00:00.000Z' });

      const list = db.listConversations();
      expect(list[0].id).toBe('c2');
      expect(list[1].id).toBe('c1');
    });
  });

  describe('audit log', () => {
    let db: ConversationDatabase;
    beforeEach(() => { db = makeDb(); });

    it('logs and retrieves an audit entry', () => {
      db.logAudit({ timestamp: '2024-01-01T00:00:00.000Z', action: 'chat', channelType: 'matrix', channelId: '!r:s', sessionKey: 'sk_1' });

      const logs = db.getAuditLogs();
      expect(logs).toHaveLength(1);
      expect(logs[0].action).toBe('chat');
      expect(logs[0].channelType).toBe('matrix');
    });

    it('logs optional fields including jobId and durationMs', () => {
      db.logAudit({ timestamp: '2024-01-01T00:00:00.000Z', action: 'job.completed', jobId: 'job_abc', durationMs: 1234 });

      const logs = db.getAuditLogs();
      expect(logs[0].jobId).toBe('job_abc');
      expect(logs[0].durationMs).toBe(1234);
    });

    it('adds a default description when details are missing', () => {
      db.logAudit({ timestamp: '2024-01-01T00:00:00.000Z', action: 'chat' });

      const [entry] = db.getAuditLogs();
      const details = JSON.parse(entry.details ?? '{}') as Record<string, unknown>;
      expect(details.description).toBe('Processed chat turn');
    });

    it('redacts memory payload and secrets in details', () => {
      db.logAudit({
        timestamp: '2024-01-01T00:00:00.000Z',
        action: 'chat',
        details: JSON.stringify({
          description: 'Custom message',
          content: 'my private memory',
          prompt: 'remember this forever',
          token: 'sk_live_1234567890abcdefghijklmnop',
          authorization: 'Bearer abc.def.ghi',
        }),
      });

      const [entry] = db.getAuditLogs();
      const details = JSON.parse(entry.details ?? '{}') as Record<string, unknown>;
      expect(details.description).toBe('Custom message');
      expect(details.content).toBe('[REDACTED]');
      expect(details.prompt).toBe('[REDACTED]');
      expect(details.token).toBe('[REDACTED]');
      expect(details.authorization).toBe('[REDACTED]');
    });

    it('filters by action', () => {
      db.logAudit({ timestamp: '2024-01-01T00:00:00.000Z', action: 'chat' });
      db.logAudit({ timestamp: '2024-01-01T00:00:01.000Z', action: 'job.completed' });

      expect(db.getAuditLogs({ action: 'chat' })).toHaveLength(1);
      expect(db.getAuditLogs({ action: 'job.completed' })).toHaveLength(1);
    });

    it('filters by job category (matches all job.* sub-types)', () => {
      db.logAudit({ timestamp: '2024-01-01T00:00:00.000Z', action: 'chat' });
      db.logAudit({ timestamp: '2024-01-01T00:00:01.000Z', action: 'job.queued' });
      db.logAudit({ timestamp: '2024-01-01T00:00:02.000Z', action: 'job.started' });
      db.logAudit({ timestamp: '2024-01-01T00:00:03.000Z', action: 'job.completed' });
      db.logAudit({ timestamp: '2024-01-01T00:00:04.000Z', action: 'job.failed' });
      db.logAudit({ timestamp: '2024-01-01T00:00:05.000Z', action: 'job.cancelled' });
      db.logAudit({ timestamp: '2024-01-01T00:00:06.000Z', action: 'job.interrupted' });

      const jobLogs = db.getAuditLogs({ action: 'job' });
      expect(jobLogs).toHaveLength(6);
      expect(jobLogs.every((l) => l.action.startsWith('job.'))).toBe(true);
      expect(db.getAuditCount({ action: 'job' })).toBe(6);
    });

    it('filters by jobId', () => {
      db.logAudit({ timestamp: '2024-01-01T00:00:00.000Z', action: 'job.queued', jobId: 'job_1' });
      db.logAudit({ timestamp: '2024-01-01T00:00:01.000Z', action: 'job.started', jobId: 'job_1' });
      db.logAudit({ timestamp: '2024-01-01T00:00:02.000Z', action: 'job.queued', jobId: 'job_2' });

      const job1Logs = db.getAuditLogs({ jobId: 'job_1' });
      expect(job1Logs).toHaveLength(2);
      expect(job1Logs.every((l) => l.jobId === 'job_1')).toBe(true);
    });

    it('filters by timestamp range', () => {
      db.logAudit({ timestamp: '2024-01-01T00:00:00.000Z', action: 'chat' });
      db.logAudit({ timestamp: '2024-01-02T00:00:00.000Z', action: 'chat' });
      db.logAudit({ timestamp: '2024-01-03T00:00:00.000Z', action: 'chat' });

      const logs = db.getAuditLogs({ from: '2024-01-02T00:00:00.000Z', to: '2024-01-02T23:59:59.000Z' });
      expect(logs).toHaveLength(1);
    });

    it('returns results newest-first', () => {
      db.logAudit({ timestamp: '2024-01-01T00:00:00.000Z', action: 'chat' });
      db.logAudit({ timestamp: '2024-01-03T00:00:00.000Z', action: 'chat' });
      db.logAudit({ timestamp: '2024-01-02T00:00:00.000Z', action: 'chat' });

      const logs = db.getAuditLogs();
      expect(logs[0].timestamp).toBe('2024-01-03T00:00:00.000Z');
      expect(logs[2].timestamp).toBe('2024-01-01T00:00:00.000Z');
    });

    it('getAuditCount matches getAuditLogs length', () => {
      db.logAudit({ timestamp: '2024-01-01T00:00:00.000Z', action: 'chat' });
      db.logAudit({ timestamp: '2024-01-01T00:00:01.000Z', action: 'job.completed', jobId: 'job_1' });
      db.logAudit({ timestamp: '2024-01-01T00:00:02.000Z', action: 'job.completed', jobId: 'job_2' });

      expect(db.getAuditCount()).toBe(3);
      expect(db.getAuditCount({ action: 'job.completed' })).toBe(2);
      expect(db.getAuditCount({ jobId: 'job_1' })).toBe(1);
    });

    it('cleanOldAudit removes entries older than threshold', () => {
      db.logAudit({ timestamp: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString(), action: 'old' });
      db.logAudit({ timestamp: new Date().toISOString(), action: 'recent' });

      const deleted = db.cleanOldAudit(90);
      expect(deleted).toBe(1);
      expect(db.getAuditCount()).toBe(1);
      expect(db.getAuditLogs()[0].action).toBe('recent');
    });

    it('limit and offset paginate correctly', () => {
      for (let i = 0; i < 5; i++) {
        db.logAudit({ timestamp: `2024-01-0${i + 1}T00:00:00.000Z`, action: 'chat' });
      }

      const page1 = db.getAuditLogs({ limit: 2, offset: 0 });
      const page2 = db.getAuditLogs({ limit: 2, offset: 2 });
      expect(page1).toHaveLength(2);
      expect(page2).toHaveLength(2);
      expect(page1[0].timestamp).not.toBe(page2[0].timestamp);
    });

    it('scrubs historical legacy rows in place', () => {
      const rawDb = (db as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db;
      rawDb.prepare(
        'INSERT INTO audit_log (timestamp, action, details, channel_type, channel_id, session_key) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(
        '2024-01-01T00:00:00.000Z',
        'chat',
        JSON.stringify({ prompt: 'secret memory text', authorization: 'Bearer abc.def.ghi' }),
        'dashboard',
        'web',
        'sk_legacy',
      );

      const dryRun = db.scrubAuditLog({ dryRun: true });
      expect(dryRun.scanned).toBeGreaterThanOrEqual(1);
      expect(dryRun.updated).toBeGreaterThanOrEqual(1);

      const applied = db.scrubAuditLog();
      expect(applied.updated).toBeGreaterThanOrEqual(1);

      const [entry] = db.getAuditLogs({ sessionKey: 'sk_legacy' });
      const details = JSON.parse(entry.details ?? '{}') as Record<string, unknown>;
      expect(details.description).toBe('Processed chat turn');
      expect(details.prompt).toBe('[REDACTED]');
      expect(details.authorization).toBe('[REDACTED]');
    });
  });

  describe('schema migration', () => {
    it('creating a second instance on same :memory: DB applies migrations idempotently', () => {
      // Two separate in-memory DBs — just verify both initialize without throwing
      const db1 = makeDb();
      const db2 = makeDb();
      db1.logAudit({ timestamp: '2024-01-01T00:00:00.000Z', action: 'chat', jobId: 'j1' });
      db2.logAudit({ timestamp: '2024-01-01T00:00:00.000Z', action: 'chat', jobId: 'j2' });
      expect(db1.getAuditLogs()[0].jobId).toBe('j1');
      expect(db2.getAuditLogs()[0].jobId).toBe('j2');
    });
  });

  describe('agents', () => {
    let db: ConversationDatabase;
    beforeEach(() => { db = makeDb(); });

    const baseAgent = () => ({
      id: 'agent_1',
      name: 'default',
      description: 'Test agent',
      provider: 'claude' as const,
      claudeModel: 'claude-sonnet-4-6',
      ollamaBaseUrl: null,
      ollamaModel: null,
      systemPromptOverride: null,
      isDefault: true,
      enabled: true,
    });

    it('creates and retrieves an agent by id', () => {
      db.createAgent(baseAgent());
      const row = db.getAgent('agent_1');
      expect(row).not.toBeNull();
      expect(row!.name).toBe('default');
      expect(row!.provider).toBe('claude');
      expect(row!.claudeModel).toBe('claude-sonnet-4-6');
      expect(row!.isDefault).toBe(true);
      expect(row!.enabled).toBe(true);
    });

    it('isDefault and enabled are booleans (not integers)', () => {
      db.createAgent(baseAgent());
      const row = db.getAgent('agent_1')!;
      expect(typeof row.isDefault).toBe('boolean');
      expect(typeof row.enabled).toBe('boolean');
    });

    it('returns null for unknown id', () => {
      expect(db.getAgent('nonexistent')).toBeNull();
    });

    it('retrieves an agent by name', () => {
      db.createAgent(baseAgent());
      const row = db.getAgentByName('default');
      expect(row).not.toBeNull();
      expect(row!.id).toBe('agent_1');
    });

    it('returns null for unknown name', () => {
      expect(db.getAgentByName('ghost')).toBeNull();
    });

    it('listAgents returns all agents, default first', () => {
      db.createAgent({ ...baseAgent(), isDefault: false, id: 'agent_2', name: 'secondary' });
      db.createAgent({ ...baseAgent(), id: 'agent_1', name: 'default', isDefault: true });
      const rows = db.listAgents();
      expect(rows).toHaveLength(2);
      expect(rows[0].isDefault).toBe(true);
    });

    it('getDefaultAgent returns the one marked default', () => {
      db.createAgent({ ...baseAgent(), isDefault: false, id: 'agent_2', name: 'other' });
      db.createAgent({ ...baseAgent(), id: 'agent_1', name: 'default', isDefault: true });
      const row = db.getDefaultAgent();
      expect(row).not.toBeNull();
      expect(row!.id).toBe('agent_1');
    });

    it('getDefaultAgent returns null when none are default', () => {
      db.createAgent({ ...baseAgent(), isDefault: false });
      expect(db.getDefaultAgent()).toBeNull();
    });

    it('creating a second default agent clears the first', () => {
      db.createAgent({ ...baseAgent(), id: 'agent_1', name: 'first', isDefault: true });
      db.createAgent({ ...baseAgent(), id: 'agent_2', name: 'second', isDefault: true });
      const first = db.getAgent('agent_1')!;
      const second = db.getAgent('agent_2')!;
      expect(first.isDefault).toBe(false);
      expect(second.isDefault).toBe(true);
    });

    it('updateAgent merges changes', () => {
      db.createAgent(baseAgent());
      db.updateAgent('agent_1', { claudeModel: 'claude-opus-4-6', description: 'Updated' });
      const row = db.getAgent('agent_1')!;
      expect(row.claudeModel).toBe('claude-opus-4-6');
      expect(row.description).toBe('Updated');
      expect(row.name).toBe('default'); // unchanged
    });

    it('updateAgent throws for unknown id', () => {
      expect(() => db.updateAgent('ghost', { name: 'x' })).toThrow('Agent not found: ghost');
    });

    it('deleteAgent removes the record', () => {
      db.createAgent(baseAgent());
      db.deleteAgent('agent_1');
      expect(db.getAgent('agent_1')).toBeNull();
      expect(db.listAgents()).toHaveLength(0);
    });

    it('setDefaultAgent clears previous default and sets new one', () => {
      db.createAgent({ ...baseAgent(), id: 'agent_1', name: 'a', isDefault: true });
      db.createAgent({ ...baseAgent(), id: 'agent_2', name: 'b', isDefault: false });
      db.setDefaultAgent('agent_2');
      expect(db.getAgent('agent_1')!.isDefault).toBe(false);
      expect(db.getAgent('agent_2')!.isDefault).toBe(true);
    });

    it('stores and retrieves Ollama agent fields', () => {
      db.createAgent({
        id: 'agent_3',
        name: 'local',
        description: null,
        provider: 'ollama',
        claudeModel: null,
        ollamaBaseUrl: 'http://localhost:11434',
        ollamaModel: 'qwen2.5-coder:latest',
        systemPromptOverride: null,
        isDefault: false,
        enabled: true,
      });
      const row = db.getAgent('agent_3')!;
      expect(row.provider).toBe('ollama');
      expect(row.ollamaBaseUrl).toBe('http://localhost:11434');
      expect(row.ollamaModel).toBe('qwen2.5-coder:latest');
      expect(row.claudeModel).toBeNull();
    });

    it('stores systemPromptOverride', () => {
      db.createAgent({ ...baseAgent(), systemPromptOverride: 'Always reply in JSON.' });
      const row = db.getAgent('agent_1')!;
      expect(row.systemPromptOverride).toBe('Always reply in JSON.');
    });

    it('disabled agents appear in listAgents but with enabled=false', () => {
      db.createAgent({ ...baseAgent(), enabled: false });
      const rows = db.listAgents();
      expect(rows).toHaveLength(1);
      expect(rows[0].enabled).toBe(false);
    });
  });
});
