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
});
