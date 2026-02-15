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

export class ConversationDatabase {
  private db: Database.Database;

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
    `);
    log.info('Database schema initialized');
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

  close(): void {
    this.db.close();
  }
}
