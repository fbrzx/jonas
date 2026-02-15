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
  private auditLog: AuditEntry[] = [];
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

    const model = process.env.AGENT_DEFAULT_MODEL ?? 'claude-sonnet-4-5-20250929';
    const abortController = new AbortController();
    this.abortControllers.set(key, abortController);

    let fullResponse = '';

    try {
      log.info({ channel: channel.type, sessionKey: key, historyLen: session.messages.length }, 'Sending query to model provider');

      fullResponse = await this.provider.query({
        prompt,
        systemPrompt,
        model,
        signal: abortController.signal,
      });

      onDelta?.(fullResponse);

    } catch (err: unknown) {
      if ((err as Error).name === 'AbortError') {
        log.info({ sessionKey: key }, 'Query aborted');
        fullResponse = '[Query aborted]';
      } else {
        log.error(err, 'Model query failed');
        throw err;
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

    this.auditLog.push({
      id: createId('audit'),
      timestamp: isoNow(),
      action: 'chat',
      channel: channel.type,
      conversationId: session.id,
    });

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
}
