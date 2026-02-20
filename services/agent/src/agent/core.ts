import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { createLogger, createId, isoNow } from '@jonas/shared/utils';
import type { Message, Conversation, Channel, AuditEntry } from '@jonas/shared/types';
import { SessionManager } from './session.js';
import { assembleSystemPrompt } from './prompt.js';
import type { MemoryRetriever } from '../memory/retriever.js';
import type { MemoryExtractor } from '../memory/extractor.js';
import type { MemoryClient } from '../memory/client.js';
import type { EmbeddingClient } from '../memory/embeddings.js';
import type { SkillRegistry } from '../skills/registry.js';
import type { ModelProvider, ProviderMessage, ProviderTool } from './providers/base.js';
import type { ConversationDatabase } from '../storage/database.js';

const log = createLogger('agent-core');
const VAULT_PATH = process.env.VAULT_PATH ?? '/data/vault';
const MODEL_TURN_TIMEOUT_MS = Number(process.env.AGENT_MODEL_TURN_TIMEOUT_MS ?? 30000);
const CLAUDE_MODEL_TURN_TIMEOUT_MS = Number(process.env.AGENT_MODEL_TURN_TIMEOUT_MS_CLAUDE ?? 120000);
const TOOL_TIMEOUT_MS = Number(process.env.AGENT_TOOL_TIMEOUT_MS ?? 15000);
const MAX_TOOL_REPEAT = Number(process.env.AGENT_TOOL_MAX_REPEAT ?? 2);
const MAX_TOOL_TURNS = Number(process.env.AGENT_TOOL_MAX_TURNS ?? 4);
const OLLAMA_TOOLS_ENABLED = String(process.env.AGENT_OLLAMA_TOOLS_ENABLED ?? 'false').toLowerCase() === 'true';

export interface AgentCoreOptions {
  retriever: MemoryRetriever;
  extractor: MemoryExtractor;
  memory?: MemoryClient;
  embeddings?: EmbeddingClient;
  provider: ModelProvider;
  mcpConfigPath: string;
  skillRegistry?: SkillRegistry;
  database?: ConversationDatabase;
}

export class AgentCore {
  private sessions = new SessionManager();
  private retriever: MemoryRetriever;
  private extractor: MemoryExtractor;
  private memory?: MemoryClient;
  private embeddings?: EmbeddingClient;
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
    this.memory = opts.memory;
    this.embeddings = opts.embeddings;
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

      const providerMessages: ProviderMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ];

      const availableTools = this.shouldEnableToolsForCurrentProvider()
        ? this.buildToolDefinitions()
        : [];
      const maxTurns = MAX_TOOL_TURNS;
      const modelTurnTimeoutMs = this.getModelTurnTimeoutMs();
      const toolCallCounts = new Map<string, number>();

      for (let turn = 0; turn < maxTurns; turn++) {
        const turnAbortController = new AbortController();
        const onOuterAbort = () => turnAbortController.abort();
        abortController.signal.addEventListener('abort', onOuterAbort, { once: true });

        let result: Awaited<ReturnType<ModelProvider['query']>>;
        try {
          result = await this.withAbortableTimeout(
            this.provider.query({
              prompt,
              systemPrompt,
              signal: turnAbortController.signal,
              messages: providerMessages,
              tools: availableTools,
            }),
            turnAbortController,
            modelTurnTimeoutMs,
            `Model turn timed out after ${modelTurnTimeoutMs}ms`,
          );
        } finally {
          abortController.signal.removeEventListener('abort', onOuterAbort);
        }

        const toolCalls = result.toolCalls ?? [];
        if (toolCalls.length === 0) {
          fullResponse = result.text;
          break;
        }

        providerMessages.push({
          role: 'assistant',
          content: result.text,
          toolCalls,
        });

        for (const call of toolCalls) {
          const signature = `${call.name}:${JSON.stringify(call.input)}`;
          const seen = (toolCallCounts.get(signature) ?? 0) + 1;
          toolCallCounts.set(signature, seen);

          if (seen > MAX_TOOL_REPEAT) {
            fullResponse = 'I detected a repeated tool-call loop and stopped to avoid hanging the request. Please rephrase or try again.';
            break;
          }

          onToolUse?.(call.name, call.input);
          const toolResult = await this.withTimeout(
            this.executeTool(call.name, call.input),
            TOOL_TIMEOUT_MS,
            `Tool ${call.name} timed out after ${TOOL_TIMEOUT_MS}ms`,
          );
          providerMessages.push({
            role: 'tool',
            name: call.name,
            content: JSON.stringify(toolResult),
          });
        }

        if (fullResponse) {
          break;
        }
      }

      if (!fullResponse) {
        fullResponse = 'I could not produce a final response after tool execution.';
      }

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

  private buildToolDefinitions(): ProviderTool[] {
    const tools: ProviderTool[] = [
      {
        name: 'memory_remember',
        description: 'Store a memory for future recall.',
        parameters: {
          type: 'object',
          properties: {
            content: { type: 'string' },
            category: { type: 'string', enum: ['episodic', 'semantic', 'procedural'] },
          },
          required: ['content', 'category'],
        },
      },
      {
        name: 'memory_recall',
        description: 'Search memories by semantic similarity.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            category: { type: 'string', enum: ['all', 'episodic', 'semantic', 'procedural'] },
            limit: { type: 'number' },
          },
          required: ['query'],
        },
      },
      {
        name: 'memory_forget',
        description: 'Delete a specific memory by ID.',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            category: { type: 'string', enum: ['episodic', 'semantic', 'procedural'] },
          },
          required: ['id', 'category'],
        },
      },
      {
        name: 'vault_read',
        description: 'Read a file from the vault.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
          },
          required: ['path'],
        },
      },
      {
        name: 'vault_write',
        description: 'Write or update a file in the vault.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            content: { type: 'string' },
            append: { type: 'boolean' },
          },
          required: ['path', 'content'],
        },
      },
      {
        name: 'vault_search',
        description: 'Search markdown files in the vault.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            directory: { type: 'string' },
          },
          required: ['query'],
        },
      },
      {
        name: 'skill_list',
        description: 'List all skills and their status.',
        parameters: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'skill_enable',
        description: 'Enable a skill by directory name.',
        parameters: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
        },
      },
      {
        name: 'skill_disable',
        description: 'Disable a skill by directory name.',
        parameters: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
        },
      },
      {
        name: 'skill_set_value',
        description: 'Set a secret/config value for a skill.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            key: { type: 'string' },
            value: { type: 'string' },
          },
          required: ['name', 'key', 'value'],
        },
      },
      {
        name: 'skill_create',
        description: 'Create a new skill.',
        parameters: {
          type: 'object',
          properties: {
            dirName: { type: 'string' },
            skillMd: { type: 'string' },
            config: { type: 'object' },
            toolServerPy: { type: 'string' },
            requirementsTxt: { type: 'string' },
          },
          required: ['dirName', 'skillMd'],
        },
      },
    ];

    return tools;
  }

  private async executeTool(name: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    switch (name) {
      case 'memory_remember': {
        if (!this.memory || !this.embeddings) {
          return { error: 'Memory tools unavailable: memory dependencies not configured' };
        }

        const content = String(input.content ?? '').trim();
        const category = String(input.category ?? '').trim() as 'episodic' | 'semantic' | 'procedural';
        if (!content || !['episodic', 'semantic', 'procedural'].includes(category)) {
          return { error: 'Invalid input for memory_remember' };
        }

        const [embedding] = await this.embeddings.embed([content]);
        const id = await this.memory.upsert(category, content, embedding, {}, 'agent');
        return { success: true, id };
      }

      case 'memory_recall': {
        if (!this.memory || !this.embeddings) {
          return { error: 'Memory tools unavailable: memory dependencies not configured' };
        }

        const query = String(input.query ?? '').trim();
        const category = String(input.category ?? 'all').trim() as 'all' | 'episodic' | 'semantic' | 'procedural';
        const limit = typeof input.limit === 'number' ? input.limit : 5;
        if (!query) {
          return { error: 'Invalid input for memory_recall: query is required' };
        }

        const embedding = await this.embeddings.embedQuery(query);
        const results = await this.memory.search(category, embedding, Math.max(1, Math.min(20, limit)));
        return {
          count: results.length,
          memories: results.map((r) => ({
            id: r.memory.id,
            category: r.memory.category,
            content: r.memory.content,
            score: Math.round(r.score * 100) / 100,
            createdAt: r.memory.createdAt,
          })),
        };
      }

      case 'memory_forget': {
        if (!this.memory) {
          return { error: 'Memory tools unavailable: memory dependency not configured' };
        }

        const id = String(input.id ?? '').trim();
        const category = String(input.category ?? '').trim() as 'episodic' | 'semantic' | 'procedural';
        if (!id || !['episodic', 'semantic', 'procedural'].includes(category)) {
          return { error: 'Invalid input for memory_forget' };
        }

        await this.memory.delete(category, id);
        return { success: true, id };
      }

      case 'vault_read': {
        const path = String(input.path ?? '').trim();
        if (!path) return { error: 'Invalid input for vault_read: path is required' };

        try {
          const fullPath = this.safeVaultPath(path);
          const content = await readFile(fullPath, 'utf-8');
          return { path, content };
        } catch (err: unknown) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            return { error: `File not found: ${path}` };
          }
          return { error: err instanceof Error ? err.message : String(err) };
        }
      }

      case 'vault_write': {
        const path = String(input.path ?? '').trim();
        const content = String(input.content ?? '');
        const append = Boolean(input.append ?? false);
        if (!path) return { error: 'Invalid input for vault_write: path is required' };

        const fullPath = this.safeVaultPath(path);
        await mkdir(dirname(fullPath), { recursive: true });

        if (append) {
          const existing = await readFile(fullPath, 'utf-8').catch(() => '');
          await writeFile(fullPath, existing + (existing ? '\n' : '') + content, 'utf-8');
        } else {
          await writeFile(fullPath, content, 'utf-8');
        }

        return { success: true, path };
      }

      case 'vault_search': {
        const query = String(input.query ?? '').trim();
        const directory = String(input.directory ?? '').trim();
        if (!query) return { error: 'Invalid input for vault_search: query is required' };

        const searchDir = this.safeVaultPath(directory);
        const results: Array<{ path: string; snippet: string }> = [];

        const walk = async (dir: string): Promise<void> => {
          const entries = await readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = join(dir, entry.name);
            if (entry.isDirectory()) {
              if (!entry.name.startsWith('.')) await walk(fullPath);
              continue;
            }

            if (!entry.name.endsWith('.md')) continue;

            const content = await readFile(fullPath, 'utf-8');
            const index = content.toLowerCase().indexOf(query.toLowerCase());
            if (index !== -1) {
              const start = Math.max(0, index - 50);
              const end = Math.min(content.length, index + query.length + 50);
              results.push({
                path: relative(VAULT_PATH, fullPath),
                snippet: content.slice(start, end).trim(),
              });
            }
          }
        };

        await walk(searchDir);
        return { count: results.length, results: results.slice(0, 20) };
      }

      case 'skill_list': {
        if (!this.skillRegistry) return { error: 'Skill tools unavailable: skill registry not configured' };
        return { skills: this.skillRegistry.list() };
      }

      case 'skill_enable': {
        if (!this.skillRegistry) return { error: 'Skill tools unavailable: skill registry not configured' };
        const requested = String(input.name ?? '').trim();
        const name = this.resolveSkillName(requested);
        if (!name) return { error: 'Invalid input for skill_enable: name is required' };
        const ok = await this.skillRegistry.enable(name);
        if (!ok) return { error: `Skill not found: ${name}` };
        return { success: true };
      }

      case 'skill_disable': {
        if (!this.skillRegistry) return { error: 'Skill tools unavailable: skill registry not configured' };
        const requested = String(input.name ?? '').trim();
        const name = this.resolveSkillName(requested);
        if (!name) return { error: 'Invalid input for skill_disable: name is required' };
        const ok = await this.skillRegistry.disable(name);
        if (!ok) return { error: `Skill not found: ${name}` };
        return { success: true };
      }

      case 'skill_set_value': {
        if (!this.skillRegistry) return { error: 'Skill tools unavailable: skill registry not configured' };
        const requested = String(input.name ?? '').trim();
        const name = this.resolveSkillName(requested);
        const key = String(input.key ?? '').trim();
        const value = String(input.value ?? '');
        if (!name || !key || !value) {
          return { error: 'Invalid input for skill_set_value: name, key and value are required' };
        }
        const ok = await this.skillRegistry.setSkillValue(name, key, value);
        if (!ok) return { error: `Skill not found: ${name}` };
        return { success: true };
      }

      case 'skill_create': {
        if (!this.skillRegistry) return { error: 'Skill tools unavailable: skill registry not configured' };
        const dirName = String(input.dirName ?? '').trim();
        const skillMd = String(input.skillMd ?? '');
        if (!dirName || !skillMd) {
          return { error: 'Invalid input for skill_create: dirName and skillMd are required' };
        }

        const created = await this.skillRegistry.create({
          dirName,
          skillMd,
          config: (input.config as Parameters<SkillRegistry['create']>[0]['config']) ?? undefined,
          toolServerPy: typeof input.toolServerPy === 'string' ? input.toolServerPy : undefined,
          requirementsTxt: typeof input.requirementsTxt === 'string' ? input.requirementsTxt : undefined,
        });

        return { success: true, skill: created };
      }

      default:
        return { error: `Unknown tool: ${name}` };
    }
  }

  private safeVaultPath(path: string): string {
    const vaultRoot = resolve(VAULT_PATH);
    const full = resolve(vaultRoot, path);
    if (full !== vaultRoot && !full.startsWith(`${vaultRoot}/`)) {
      throw new Error('Path traversal blocked');
    }
    return full;
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    timeoutMessage: string,
  ): Promise<T> {
    if (timeoutMs <= 0) return promise;

    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(timeoutMessage));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async withAbortableTimeout<T>(
    promise: Promise<T>,
    abortController: AbortController,
    timeoutMs: number,
    timeoutMessage: string,
  ): Promise<T> {
    if (timeoutMs <= 0) return promise;

    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => {
            abortController.abort();
            reject(new Error(timeoutMessage));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private resolveSkillName(requested: string): string {
    if (!this.skillRegistry) return requested;

    const direct = requested.trim();
    if (!direct) return '';
    if (this.skillRegistry.get(direct)) return direct;

    const normalized = direct.toLowerCase();
    const byDir = this.skillRegistry
      .list()
      .find((skill) => skill.dirName.toLowerCase() === normalized);
    if (byDir) return byDir.dirName;

    const byMetaName = this.skillRegistry
      .list()
      .find((skill) => skill.metadata.name.toLowerCase() === normalized);
    if (byMetaName) return byMetaName.dirName;

    return direct;
  }

  private getModelTurnTimeoutMs(): number {
    const providerName = this.provider.getName();
    if (providerName.startsWith('claude:')) {
      return CLAUDE_MODEL_TURN_TIMEOUT_MS;
    }
    return MODEL_TURN_TIMEOUT_MS;
  }

  private shouldEnableToolsForCurrentProvider(): boolean {
    const providerName = this.provider.getName();

    if (providerName.startsWith('claude:')) {
      return true;
    }

    if (providerName.startsWith('ollama:')) {
      return OLLAMA_TOOLS_ENABLED;
    }

    return true;
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
