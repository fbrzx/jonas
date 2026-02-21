import Database from 'better-sqlite3';
import { createLogger } from '@jonas/shared/utils';
import type { Message, Channel } from '@jonas/shared/types';

const log = createLogger('database');

export interface ConversationRow {
  id: string;
  sessionKey: string;
  channelType: string;
  channelId: string;
  createdAt: string;
  updatedAt: string;
}

export interface MessageRow {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export interface AuditRow {
  id?: number;
  timestamp: string;
  action: string;
  details?: string;
  channelType?: string;
  channelId?: string;
  sessionKey?: string;
  jobId?: string;
  model?: string;
  tokensUsed?: number;
  durationMs?: number;
  createdAt?: string;
}

export class ConversationDatabase {
  private db: Database.Database;

  private static readonly SECRET_KEY_RE = /(secret|token|password|passphrase|api[_-]?key|authorization|cookie|private[_-]?key|oauth)/i;
  private static readonly SENSITIVE_PAYLOAD_KEY_RE = /^(content|prompt|query|result|input|output|memory|memories|embedding|vector|raw|response)$/i;

  constructor(dbPath: string) {
    log.info({ dbPath }, 'Initializing conversation database');
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        session_key TEXT NOT NULL,
        channel_type TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_session_key ON conversations(session_key);
      CREATE INDEX IF NOT EXISTS idx_updated_at ON conversations(updated_at);

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_conversation_id ON messages(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);

      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        action TEXT NOT NULL,
        details TEXT,
        channel_type TEXT,
        channel_id TEXT,
        session_key TEXT,
        model TEXT,
        tokens_used INTEGER,
        duration_ms INTEGER,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
      CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
      CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_log(session_key);
      CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
    `);

    // Incremental migrations — safe to run on every startup
    this.migrate();

    log.info('Database schema initialized');
  }

  private migrate(): void {
    // Add job_id column (introduced with background job manager)
    try {
      this.db.exec('ALTER TABLE audit_log ADD COLUMN job_id TEXT');
      log.info('Migration: added job_id column to audit_log');
    } catch {
      // Column already exists — expected on subsequent startups
    }
    try {
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_audit_job ON audit_log(job_id)');
    } catch {
      // Index already exists
    }
  }

  saveConversation(conv: ConversationRow): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO conversations (id, session_key, channel_type, channel_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(conv.id, conv.sessionKey, conv.channelType, conv.channelId, conv.createdAt, conv.updatedAt);
  }

  saveMessage(msg: MessageRow): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO messages (id, conversation_id, role, content, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(msg.id, msg.conversationId, msg.role, msg.content, msg.timestamp);
  }

  getConversation(sessionKey: string): { conv: ConversationRow; messages: MessageRow[] } | null {
    const conv = this.db.prepare(`
      SELECT id, session_key as sessionKey, channel_type as channelType,
             channel_id as channelId, created_at as createdAt, updated_at as updatedAt
      FROM conversations
      WHERE session_key = ?
    `).get(sessionKey) as ConversationRow | undefined;

    if (!conv) return null;

    const messages = this.db.prepare(`
      SELECT id, conversation_id as conversationId, role, content, timestamp
      FROM messages
      WHERE conversation_id = ?
      ORDER BY timestamp ASC
    `).all(conv.id) as MessageRow[];

    return { conv, messages };
  }

  listConversations(limit = 50): ConversationRow[] {
    return this.db.prepare(`
      SELECT id, session_key as sessionKey, channel_type as channelType,
             channel_id as channelId, created_at as createdAt, updated_at as updatedAt
      FROM conversations
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(limit) as ConversationRow[];
  }

  getConversationMessages(conversationId: string): MessageRow[] {
    return this.db.prepare(`
      SELECT id, conversation_id as conversationId, role, content, timestamp
      FROM messages
      WHERE conversation_id = ?
      ORDER BY timestamp ASC
    `).all(conversationId) as MessageRow[];
  }

  deleteConversation(sessionKey: string): void {
    const conv = this.db.prepare('SELECT id FROM conversations WHERE session_key = ?').get(sessionKey) as { id: string } | undefined;
    if (!conv) return;

    this.db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(conv.id);
    this.db.prepare('DELETE FROM conversations WHERE id = ?').run(conv.id);
    log.info({ sessionKey }, 'Conversation deleted');
  }

  // Audit log methods
  logAudit(entry: Omit<AuditRow, 'id' | 'createdAt'>): void {
    const sanitizedDetails = this.sanitizeAuditDetails(entry.action, entry.details);

    const stmt = this.db.prepare(`
      INSERT INTO audit_log (timestamp, action, details, channel_type, channel_id, session_key, job_id, model, tokens_used, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      entry.timestamp,
      entry.action,
      sanitizedDetails ?? null,
      entry.channelType ?? null,
      entry.channelId ?? null,
      entry.sessionKey ?? null,
      entry.jobId ?? null,
      entry.model ?? null,
      entry.tokensUsed ?? null,
      entry.durationMs ?? null,
    );
  }

  private sanitizeAuditDetails(action: string, details?: string): string {
    const description = this.defaultDescription(action);
    if (!details || !details.trim()) {
      return JSON.stringify({ description });
    }

    try {
      const parsed = JSON.parse(details) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const sanitized = this.sanitizeValue(parsed) as Record<string, unknown>;
        if (typeof sanitized.description !== 'string' || !sanitized.description.trim()) {
          sanitized.description = description;
        }
        return JSON.stringify(sanitized);
      }
    } catch {
      // Fallback below for non-JSON legacy details
    }

    const redacted = this.redactText(details);
    return JSON.stringify({
      description,
      note: redacted.length > 200 ? `${redacted.slice(0, 200)}...` : redacted,
    });
  }

  private sanitizeValue(value: unknown, parentKey?: string): unknown {
    if (value === null || value === undefined) return value;

    if (typeof value === 'string') {
      if (parentKey && ConversationDatabase.SENSITIVE_PAYLOAD_KEY_RE.test(parentKey)) {
        return '[REDACTED]';
      }
      const redacted = this.redactText(value);
      return redacted.length > 400 ? `${redacted.slice(0, 400)}...` : redacted;
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
      return value;
    }

    if (Array.isArray(value)) {
      if (parentKey && ConversationDatabase.SENSITIVE_PAYLOAD_KEY_RE.test(parentKey)) {
        return '[REDACTED]';
      }
      return value.slice(0, 20).map((item) => this.sanitizeValue(item, parentKey));
    }

    if (typeof value === 'object') {
      const source = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [key, raw] of Object.entries(source)) {
        if (ConversationDatabase.SECRET_KEY_RE.test(key)) {
          out[key] = '[REDACTED]';
          continue;
        }
        if (ConversationDatabase.SENSITIVE_PAYLOAD_KEY_RE.test(key)) {
          out[key] = '[REDACTED]';
          continue;
        }
        out[key] = this.sanitizeValue(raw, key);
      }
      return out;
    }

    return String(value);
  }

  private redactText(value: string): string {
    return value
      .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
      .replace(/\b(?:sk|pk|rk|vk)_[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
      .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED]')
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+\b/g, '[REDACTED]')
      .replace(/\b[A-Za-z0-9+/]{32,}={0,2}\b/g, '[REDACTED]');
  }

  private defaultDescription(action: string): string {
    const labels: Record<string, string> = {
      chat: 'Processed chat turn',
      'job.queued': 'Queued background job',
      'job.started': 'Started background job',
      'job.completed': 'Completed background job',
      'job.failed': 'Background job failed',
      'job.cancelled': 'Cancelled background job',
      'job.interrupted': 'Background job interrupted',
    };
    return labels[action] ?? `Audit action: ${action}`;
  }

  getAuditLogs(options: {
    limit?: number;
    offset?: number;
    action?: string;
    from?: string;
    to?: string;
    sessionKey?: string;
    jobId?: string;
  } = {}): AuditRow[] {
    const { limit = 100, offset = 0, action, from, to, sessionKey, jobId } = options;

    let query = `
      SELECT id, timestamp, action, details, channel_type as channelType,
             channel_id as channelId, session_key as sessionKey, job_id as jobId,
             model, tokens_used as tokensUsed, duration_ms as durationMs, created_at as createdAt
      FROM audit_log
      WHERE 1=1
    `;

    const params: unknown[] = [];

    if (action) {
      query += ' AND action = ?';
      params.push(action);
    }

    if (sessionKey) {
      query += ' AND session_key = ?';
      params.push(sessionKey);
    }

    if (jobId) {
      query += ' AND job_id = ?';
      params.push(jobId);
    }

    if (from) {
      query += ' AND timestamp >= ?';
      params.push(from);
    }

    if (to) {
      query += ' AND timestamp <= ?';
      params.push(to);
    }

    query += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    return this.db.prepare(query).all(...params) as AuditRow[];
  }

  getAuditCount(options: {
    action?: string;
    from?: string;
    to?: string;
    sessionKey?: string;
    jobId?: string;
  } = {}): number {
    const { action, from, to, sessionKey, jobId } = options;

    let query = 'SELECT COUNT(*) as count FROM audit_log WHERE 1=1';
    const params: unknown[] = [];

    if (action) {
      query += ' AND action = ?';
      params.push(action);
    }

    if (sessionKey) {
      query += ' AND session_key = ?';
      params.push(sessionKey);
    }

    if (jobId) {
      query += ' AND job_id = ?';
      params.push(jobId);
    }

    if (from) {
      query += ' AND timestamp >= ?';
      params.push(from);
    }

    if (to) {
      query += ' AND timestamp <= ?';
      params.push(to);
    }

    const result = this.db.prepare(query).get(...params) as { count: number };
    return result.count;
  }

  cleanOldAudit(daysToKeep = 90): number {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
    const cutoff = cutoffDate.toISOString();

    const result = this.db.prepare('DELETE FROM audit_log WHERE timestamp < ?').run(cutoff);
    log.info({ deleted: result.changes, daysToKeep }, 'Cleaned old audit entries');
    return result.changes;
  }

  scrubAuditLog(options: { limit?: number; dryRun?: boolean } = {}): { scanned: number; updated: number } {
    const { dryRun = false } = options;
    const limit = Math.max(1, Math.min(5000, options.limit ?? 1000));

    const rows = this.db.prepare(`
      SELECT id, action, details
      FROM audit_log
      ORDER BY id ASC
      LIMIT ?
    `).all(limit) as Array<{ id: number; action: string; details: string | null }>;

    let updated = 0;
    const updateStmt = this.db.prepare('UPDATE audit_log SET details = ? WHERE id = ?');

    const applyUpdates = this.db.transaction((changes: Array<{ id: number; details: string }>) => {
      for (const change of changes) {
        updateStmt.run(change.details, change.id);
      }
    });

    const changes: Array<{ id: number; details: string }> = [];
    for (const row of rows) {
      const sanitized = this.sanitizeAuditDetails(row.action, row.details ?? undefined);
      if ((row.details ?? '') !== sanitized) {
        updated++;
        if (!dryRun) {
          changes.push({ id: row.id, details: sanitized });
        }
      }
    }

    if (!dryRun && changes.length > 0) {
      applyUpdates(changes);
    }

    log.info({ scanned: rows.length, updated, dryRun, limit }, 'Audit scrub completed');
    return { scanned: rows.length, updated };
  }

  close(): void {
    this.db.close();
  }
}
