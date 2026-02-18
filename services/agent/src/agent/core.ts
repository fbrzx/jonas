import { readFile, writeFile } from 'node:fs/promises';
import { createLogger, createId, isoNow } from '@jonas/shared/utils';
import type { Message, Conversation, Channel, AuditEntry } from '@jonas/shared/types';
import { SessionManager } from './session.js';
import { assembleSystemPrompt } from './prompt.js';
import type { MemoryRetriever } from '../memory/retriever.js';
import type { MemoryExtractor } from '../memory/extractor.js';
import type { SkillRegistry } from '../skills/registry.js';
import type { ModelProvider } from './providers/base.js';
import type { ConversationDatabase } from '../storage/database.js';

const log = createLogger('agent-core');

export interface AgentCoreOptions {
  retriever: MemoryRetriever;
  extractor: MemoryExtractor;
  provider: ModelProvider;
  mcpConfigPath: string;
  skillRegistry?: SkillRegistry;
  database?: ConversationDatabase;
}

export class AgentCore {
  private sessions = new SessionManager();
  private retriever: MemoryRetriever;
  private extractor: MemoryExtractor;
  private provider: ModelProvider;
  private mcpConfigPath: string;
  private skillRegistry?: SkillRegistry;
  private database?: ConversationDatabase;
  private auditLog: AuditEntry[] = []; // Keep last 100 in memory for quick access
  private startedAt = Date.now();
  private abortControllers = new Map<string, AbortController>();

  constructor(opts: AgentCoreOptions) {
    this.retriever = opts.retriever;
    this.extractor = opts.extractor;
    this.provider = opts.provider;
    this.mcpConfigPath = opts.mcpConfigPath;
    this.skillRegistry = opts.skillRegistry;
    this.database = opts.database;
  }

  get uptime(): number {
    return Date.now() - this.startedAt;
  }

  get audit(): AuditEntry[] {
    return this.auditLog;
  }

  get activeConversationCount(): number {
    return this.sessions.count;
  }

  getProviderName(): string {
    return this.provider.getName();
  }

  async chat(
    userMessage: string,
    channel: Channel,
    sessionKey?: string,
    onDelta?: (text: string) => void,
    onToolUse?: (name: string, input: Record<string, unknown>) => void
  ): Promise<string> {
    const key = sessionKey ?? `${channel.type}:${channel.id}`;
    const session = this.sessions.getOrCreate(key);

    // Load conversation history from database if this is a new session
    if (this.database && session.messages.length === 0) {
      const stored = this.database.getConversation(key);
      if (stored) {
        session.id = stored.conv.id;
        session.createdAt = stored.conv.createdAt;
        session.messages = stored.messages.map(m => ({
          id: m.id,
          role: m.role,
          content: m.content,
          channel,
          conversationId: m.conversationId,
          timestamp: m.timestamp,
        }));
        log.info({ sessionKey: key, messageCount: session.messages.length }, 'Loaded conversation from database');
      }
    }

    const memories = await this.retriever.retrieve(userMessage);
    const skillPrompts = this.skillRegistry?.getEnabledPrompts();
    const systemPrompt = assembleSystemPrompt(memories, skillPrompts);

    // Rebuild MCP config with current skill servers
    await this.rebuildMcpConfig();

    const userMsg: Message = {
      id: createId('msg'),
      role: 'user',
      content: userMessage,
      channel,
      conversationId: session.id,
      timestamp: isoNow(),
    };
    session.messages.push(userMsg);

    // Build prompt with conversation history for context
    const prompt = this.buildPromptWithHistory(session.messages, userMessage);

    const abortController = new AbortController();
    this.abortControllers.set(key, abortController);

    let fullResponse = '';

    try {
      log.info({ channel: channel.type, sessionKey: key, historyLen: session.messages.length }, 'Sending query to model provider');

      fullResponse = await this.provider.query({
        prompt,
        systemPrompt,
        signal: abortController.signal,
      });

      onDelta?.(fullResponse);

    } catch (err: unknown) {
      if ((err as Error).name === 'AbortError') {
        log.info({ sessionKey: key }, 'Query aborted');
        fullResponse = '[Query aborted]';
      } else {
        log.error(err, 'Model query failed');
        // Re-throw with better context
        const error = err instanceof Error ? err : new Error(String(err));
        error.message = this.categorizeError(error.message);
        throw error;
      }
    } finally {
      this.abortControllers.delete(key);
    }

    const assistantMsg: Message = {
      id: createId('msg'),
      role: 'assistant',
      content: fullResponse,
      channel,
      conversationId: session.id,
      timestamp: isoNow(),
    };
    session.messages.push(assistantMsg);

    // Save to database
    if (this.database) {
      try {
        session.updatedAt = isoNow();
        this.database.saveConversation({
          id: session.id,
          sessionKey: key,
          channelType: channel.type,
          channelId: channel.id,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
        });
        this.database.saveMessage({
          id: userMsg.id,
          conversationId: session.id,
          role: userMsg.role,
          content: userMsg.content,
          timestamp: userMsg.timestamp,
        });
        this.database.saveMessage({
          id: assistantMsg.id,
          conversationId: session.id,
          role: assistantMsg.role,
          content: assistantMsg.content,
          timestamp: assistantMsg.timestamp,
        });
      } catch (err) {
        log.warn(err, 'Failed to save conversation to database');
      }
    }

    this.extractor.extractFromTurn(userMessage, fullResponse).catch((err) => {
      log.warn(err, 'Memory extraction failed');
    });

    const auditEntry: AuditEntry = {
      id: createId('audit'),
      timestamp: isoNow(),
      action: 'chat',
      channel: channel.type,
      conversationId: session.id,
    };

    // Add to in-memory log (keep last 100)
    this.auditLog.push(auditEntry);
    if (this.auditLog.length > 100) {
      this.auditLog.shift();
    }

    // Persist to database
    if (this.database) {
      this.database.logAudit({
        timestamp: auditEntry.timestamp,
        action: auditEntry.action,
        details: JSON.stringify({ conversationId: auditEntry.conversationId }),
        channelType: channel.type,
        channelId: channel.id,
        sessionKey: key,
      });
    }

    if (session.messages.length > 20) {
      session.messages = session.messages.slice(-10);
      log.info({ sessionKey: key }, 'Compacted conversation history');
    }

    return fullResponse;
  }

  private buildPromptWithHistory(messages: Message[], currentMessage: string): string {
    // Only the current message if no prior history
    if (messages.length <= 1) return currentMessage;

    // Include up to the last 10 messages (excluding the current one which is last)
    const history = messages.slice(-11, -1);
    if (history.length === 0) return currentMessage;

    const lines = history.map((m) =>
      m.role === 'user' ? `User: ${m.content}` : `Assistant: ${m.content}`
    );
    lines.push(`User: ${currentMessage}`);

    return `<conversation_history>\n${lines.join('\n\n')}\n</conversation_history>\n\nRespond to the latest User message above. Use the conversation history for context.`;
  }

  /** Rebuild MCP config to include dynamically enabled skill tool servers. */
  private async rebuildMcpConfig(): Promise<void> {
    if (!this.skillRegistry) return;

    try {
      const existing = JSON.parse(await readFile(this.mcpConfigPath, 'utf-8'));
      const skillServers = await this.skillRegistry.getMcpServers();

      // Remove old skill-* entries, keep non-skill servers
      const mcpServers: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(existing.mcpServers ?? {})) {
        if (!key.startsWith('skill-')) mcpServers[key] = val;
      }
      // Add current skill servers
      Object.assign(mcpServers, skillServers);

      const newConfig = { mcpServers };
      await writeFile(this.mcpConfigPath, JSON.stringify(newConfig, null, 2));
    } catch (err) {
      log.warn(err, 'Failed to rebuild MCP config with skill servers');
    }
  }

  abort(sessionKey: string): boolean {
    const controller = this.abortControllers.get(sessionKey);
    if (controller) {
      controller.abort();
      return true;
    }
    return false;
  }

  getConversations(): Conversation[] {
    return this.sessions.list();
  }

  resetSession(sessionKey: string): void {
    this.sessions.reset(sessionKey);
    if (this.database) {
      try {
        this.database.deleteConversation(sessionKey);
      } catch (err) {
        log.warn(err, 'Failed to delete conversation from database');
      }
    }
  }

  /**
   * Categorize error messages to help users understand what went wrong.
   * Detects common error patterns and provides actionable feedback.
   */
  private categorizeError(message: string): string {
    const lower = message.toLowerCase();

    // Token/context length errors
    if (lower.includes('context') && (lower.includes('length') || lower.includes('limit') || lower.includes('token'))) {
      return 'Conversation is too long. The context limit has been exceeded. Try starting a new conversation or ask me to reset the session.';
    }

    // Rate limiting
    if (lower.includes('rate limit') || lower.includes('too many requests') || lower.includes('429')) {
      return 'Rate limit exceeded. The API is receiving too many requests. Please wait a moment and try again.';
    }

    // Authentication/OAuth errors
    if (lower.includes('unauthorized') || lower.includes('401') || lower.includes('authentication') || lower.includes('invalid token')) {
      return 'Authentication error. The OAuth token may have expired or been revoked. Please check the agent configuration.';
    }

    // Timeout errors
    if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('etimedout')) {
      return 'Request timed out. The model took too long to respond. Please try again with a simpler query.';
    }

    // Network/connection errors
    if (lower.includes('network') || lower.includes('econnrefused') || lower.includes('enotfound') || lower.includes('connection')) {
      return 'Network error. Unable to connect to the Claude API. Please check your internet connection.';
    }

    // Claude CLI specific errors
    if (lower.includes('claude cli exited with code')) {
      return `${message}. This may indicate a configuration issue or the request was too complex.`;
    }

    // MCP/tool errors
    if (lower.includes('mcp') || lower.includes('tool') && lower.includes('error')) {
      return `Tool execution error: ${message}`;
    }

    // If we can't categorize it, return the original message with a prefix
    return `Error: ${message}`;
  }
}
