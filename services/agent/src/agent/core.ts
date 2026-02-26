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
import type { BackgroundJobManager } from '../tasks/job-manager.js';

const log = createLogger('agent-core');
const VAULT_PATH = process.env.VAULT_PATH ?? '/data/vault';
const MODEL_TURN_TIMEOUT_MS = Number(process.env.AGENT_MODEL_TURN_TIMEOUT_MS ?? 30000);
const CLAUDE_MODEL_TURN_TIMEOUT_MS = Number(process.env.AGENT_MODEL_TURN_TIMEOUT_MS_CLAUDE ?? 120000);
const TOOL_TIMEOUT_MS = Number(process.env.AGENT_TOOL_TIMEOUT_MS ?? 15000);
const MAX_TOOL_REPEAT = Number(process.env.AGENT_TOOL_MAX_REPEAT ?? 2);
const MAX_TOOL_TURNS = Number(process.env.AGENT_TOOL_MAX_TURNS ?? 4);
const OLLAMA_TOOLS_ENABLED = String(process.env.AGENT_OLLAMA_TOOLS_ENABLED ?? 'false').toLowerCase() === 'true';
const OLLAMA_GROUNDING_MODE = String(process.env.AGENT_OLLAMA_GROUNDING_MODE ?? 'warn').toLowerCase();
const DELEGATION_TIMEOUT_MS = Number(process.env.AGENT_DELEGATION_TIMEOUT_MS ?? 120000);

/**
 * Minimal interface exposed to AgentCore for agent delegation.
 * Defined here (not in registry.ts) to avoid a circular import.
 */
export interface AgentDelegateRegistry {
  getByName(name: string): AgentCore | undefined;
  list(): Array<{ row: { name: string; description: string | null }; active: boolean; providerName: string }>;
}

export interface AgentCoreOptions {
  retriever: MemoryRetriever;
  extractor: MemoryExtractor;
  memory?: MemoryClient;
  embeddings?: EmbeddingClient;
  provider: ModelProvider;
  mcpConfigPath: string;
  skillRegistry?: SkillRegistry;
  database?: ConversationDatabase;
  jobManager?: BackgroundJobManager;
  agentRegistry?: AgentDelegateRegistry;
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
  private jobManager?: BackgroundJobManager;
  private agentRegistry?: AgentDelegateRegistry;
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
    this.jobManager = opts.jobManager;
    this.agentRegistry = opts.agentRegistry;
  }

  /** Allow late injection of job manager (avoids circular dependency) */
  setJobManager(jobManager: BackgroundJobManager): void {
    this.jobManager = jobManager;
  }

  /** Allow late injection of agent registry (avoids circular dependency) */
  setAgentRegistry(registry: AgentDelegateRegistry): void {
    this.agentRegistry = registry;
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

  private recordAuditEvent(params: {
    action: string;
    channel: Channel;
    sessionKey: string;
    conversationId: string;
    details?: Record<string, unknown>;
    model?: string;
    durationMs?: number;
    logType?: 'info' | 'debug' | 'warn' | 'error';
  }): void {
    const entry: AuditEntry = {
      id: createId('audit'),
      timestamp: isoNow(),
      action: params.action,
      logType: params.logType ?? (params.action === 'tool_use' ? 'info' : 'info'),
      channel: params.channel.type,
      conversationId: params.conversationId,
    };

    this.auditLog.push(entry);
    if (this.auditLog.length > 100) {
      this.auditLog.shift();
    }

    if (!this.database) return;

    this.database.logAudit({
      timestamp: entry.timestamp,
      action: params.action,
      logType: entry.logType,
      details: params.details ? JSON.stringify(params.details) : undefined,
      channelType: params.channel.type,
      channelId: params.channel.id,
      sessionKey: params.sessionKey,
      model: params.model,
      durationMs: params.durationMs,
    });
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
        log.debug({ sessionKey: key, messageCount: session.messages.length }, 'Loaded conversation from database');
      }
    }

    const memories = await this.retriever.retrieve(userMessage);
    const skillPrompts = this.skillRegistry?.getEnabledPrompts();
    const systemPrompt = assembleSystemPrompt(memories, skillPrompts, {
      providerName: this.provider.getName(),
      channel,
    });

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
    const executedToolNames = new Set<string>();

    try {
      log.info({ channel: channel.type, channelId: channel.id, sessionKey: key, historyLen: session.messages.length, userMessage: userMessage.slice(0, 80) }, 'Sending query to model provider');

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
      const groundedVaultPaths = new Set<string>();
      const groundedJobIds = new Set<string>();
      const groundedMemoryIds = new Set<string>();

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
            this.executeTool(call.name, call.input, channel),
            TOOL_TIMEOUT_MS,
            `Tool ${call.name} timed out after ${TOOL_TIMEOUT_MS}ms`,
          );

          const action = call.name.startsWith('memory_') ? 'memory' : 'tool_use';
          this.recordAuditEvent({
            action,
            channel,
            sessionKey: key,
            conversationId: session.id,
            logType: typeof toolResult.error === 'string' ? 'error' : 'info',
            details: {
              description: `Executed ${action === 'memory' ? 'memory' : 'tool'}: ${call.name}`,
              tool: call.name,
              inputKeys: Object.keys(call.input ?? {}),
              success: typeof toolResult.error !== 'string',
              ...(typeof toolResult.error === 'string' ? { error: toolResult.error } : {}),
            },
          });

          executedToolNames.add(call.name);
          this.collectGroundedVaultPaths(call.name, toolResult, groundedVaultPaths);
          this.collectGroundedIds(call.name, toolResult, groundedJobIds, groundedMemoryIds);
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
        fullResponse = this.renderErrorMessage({
          userMessage: 'Sorry, I could not produce a final response after tool execution. This may be a temporary issue. Please try again or contact support if it persists.',
          technical: 'No response was generated after tool execution. This may indicate a tool output, formatting, or context/token issue.'
        });
      }

      fullResponse = await this.applyOllamaGrounding(
        fullResponse,
        executedToolNames,
        groundedVaultPaths,
        groundedJobIds,
        groundedMemoryIds,
      );

      onDelta?.(fullResponse);

    } catch (err: unknown) {
      if ((err as Error).name === 'AbortError') {
        log.debug({ sessionKey: key }, 'Query aborted');
        fullResponse = this.renderErrorMessage({
          userMessage: 'Your request was aborted. If this was not intentional, please try again. If the problem persists, contact the operator.',
          technical: 'AbortError thrown during model/tool execution.'
        });
      } else {
        log.error(err, 'Model query failed');
        // Re-throw with better context
        const error = err instanceof Error ? err : new Error(String(err));
        const friendly = this.categorizeError(error.message);
        fullResponse = this.renderErrorMessage({
          userMessage: friendly,
          technical: error.stack || String(error)
        });
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

    this.recordAuditEvent({
      action: 'chat',
      channel,
      sessionKey: key,
      conversationId: session.id,
      logType: 'info',
      details: {
        description: 'Processed chat turn',
        conversationId: session.id,
        userMessageLength: userMessage.length,
        responseLength: fullResponse.length,
        toolsUsed: Array.from(executedToolNames),
      },
      model: this.provider.getName(),
    });

    if (session.messages.length > 20) {
      session.messages = session.messages.slice(-10);
      log.debug({ sessionKey: key }, 'Compacted conversation history');
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
      {
        name: 'job_run',
        description:
          'Spawn a background sub-agent to execute a task asynchronously. Returns a job ID immediately. Use this for long-running tasks so you can respond to the user right away. The job runs independently and delivers its result to the target channel when done.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Short human-readable name for the job' },
            prompt: { type: 'string', description: 'The full instruction for the sub-agent to execute' },
            targetChannelType: { type: 'string', description: 'Channel type to deliver the result to (e.g. "telegram")' },
            targetChannelId: { type: 'string', description: 'Channel ID for result delivery' },
            timeoutMs: { type: 'number', description: 'Timeout in milliseconds (default: 600000 = 10min)' },
          },
          required: ['name', 'prompt'],
        },
      },
      {
        name: 'job_status',
        description: 'Check the status and result of a background job by ID.',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Job ID returned by job_run' },
          },
          required: ['id'],
        },
      },
      {
        name: 'job_list',
        description: 'List recent background jobs with their statuses.',
        parameters: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'Maximum number of jobs to return (default: 20)' },
          },
        },
      },
      {
        name: 'job_cancel',
        description: 'Cancel a queued or running background job.',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Job ID to cancel' },
          },
          required: ['id'],
        },
      },
    ];

    if (this.agentRegistry) {
      tools.push(
        {
          name: 'agent_list',
          description: 'List all available agents with their names, descriptions, and status.',
          parameters: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'delegate_to_agent',
          description:
            'Delegate a task or question to a specialized agent by name. The agent will process the task and return its response. Use agent_list first to discover available agents.',
          parameters: {
            type: 'object',
            properties: {
              agentName: { type: 'string', description: 'Name of the target agent to delegate to' },
              task: { type: 'string', description: 'The full task or question for the target agent to handle' },
            },
            required: ['agentName', 'task'],
          },
        },
      );
    }

    return tools;
  }

  private async executeTool(name: string, input: Record<string, unknown>, channel?: Channel): Promise<Record<string, unknown>> {
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

      case 'job_run': {
        if (!this.jobManager) {
          return { error: 'Job manager unavailable: not configured' };
        }

        const jobName = String(input.name ?? '').trim();
        const jobPrompt = String(input.prompt ?? '').trim();
        if (!jobName || !jobPrompt) {
          return { error: 'Invalid input for job_run: name and prompt are required' };
        }

        let targetChannel: { type: string; id: string } | undefined;
        if (typeof input.targetChannelType === 'string' && typeof input.targetChannelId === 'string') {
          // Normalize: strip 'channel:' prefix so registry lookup works (handlers keyed by dirName)
          targetChannel = {
            type: input.targetChannelType.replace(/^channel:/, ''),
            id: input.targetChannelId,
          };
        } else if (channel) {
          // Auto-inherit the originating channel so results are always delivered back
          targetChannel = {
            type: channel.type.replace(/^channel:/, ''),
            id: channel.id,
          };
        }

        const timeoutMs =
          typeof input.timeoutMs === 'number' && input.timeoutMs > 0
            ? input.timeoutMs
            : undefined;

        const job = await this.jobManager.spawn({ name: jobName, prompt: jobPrompt, targetChannel, timeoutMs });
        return {
          jobId: job.id,
          status: job.status,
          message: `Background sub-agent spawned as job "${job.name}" (ID: ${job.id}). It will run independently and ${targetChannel ? `deliver results to ${targetChannel.type}:${targetChannel.id}` : 'store results for retrieval via job_status'}.`,
        };
      }

      case 'job_status': {
        if (!this.jobManager) {
          return { error: 'Job manager unavailable: not configured' };
        }

        const jobId = String(input.id ?? '').trim();
        if (!jobId) {
          return { error: 'Invalid input for job_status: id is required' };
        }

        const job = this.jobManager.get(jobId);
        if (!job) {
          return { error: `Job not found: ${jobId}` };
        }

        return {
          id: job.id,
          name: job.name,
          status: job.status,
          createdAt: job.createdAt,
          startedAt: job.startedAt,
          completedAt: job.completedAt,
          result: job.result,
          error: job.error,
          targetChannel: job.targetChannel,
        };
      }

      case 'job_list': {
        if (!this.jobManager) {
          return { error: 'Job manager unavailable: not configured' };
        }

        const limit = typeof input.limit === 'number' ? Math.max(1, Math.min(100, input.limit)) : 20;
        const jobs = this.jobManager.list().slice(-limit).map((j) => ({
          id: j.id,
          name: j.name,
          status: j.status,
          createdAt: j.createdAt,
          startedAt: j.startedAt,
          completedAt: j.completedAt,
          scheduledTaskId: j.scheduledTaskId,
        }));

        return { count: jobs.length, jobs };
      }

      case 'job_cancel': {
        if (!this.jobManager) {
          return { error: 'Job manager unavailable: not configured' };
        }

        const jobId = String(input.id ?? '').trim();
        if (!jobId) {
          return { error: 'Invalid input for job_cancel: id is required' };
        }

        const cancelled = await this.jobManager.cancel(jobId);
        if (!cancelled) {
          return { error: `Job not found or already in terminal state: ${jobId}` };
        }

        return { success: true, message: `Job ${jobId} cancelled` };
      }

      case 'agent_list': {
        if (!this.agentRegistry) {
          return { error: 'Agent delegation unavailable: agent registry not configured' };
        }
        const agents = this.agentRegistry.list().map((item) => ({
          name: item.row.name,
          description: item.row.description,
          active: item.active,
          providerName: item.providerName,
        }));
        return { count: agents.length, agents };
      }

      case 'delegate_to_agent': {
        if (!this.agentRegistry) {
          return { error: 'Agent delegation unavailable: agent registry not configured' };
        }

        const agentName = String(input.agentName ?? '').trim();
        const task = String(input.task ?? '').trim();
        if (!agentName || !task) {
          return { error: 'Invalid input for delegate_to_agent: agentName and task are required' };
        }

        const target = this.agentRegistry.getByName(agentName);
        if (!target) {
          return { error: `Agent not found: ${agentName}` };
        }

        const callId = createId('delegate');
        const delegateChannel: Channel = { type: 'internal', id: 'delegation' };
        const sessionKey = `delegate:${callId}`;

        try {
          const result = await this.withTimeout(
            target.chat(task, delegateChannel, sessionKey),
            DELEGATION_TIMEOUT_MS,
            `Delegation to agent "${agentName}" timed out after ${DELEGATION_TIMEOUT_MS}ms`,
          );
          return { agentName, result };
        } catch (err: unknown) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
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

  private renderErrorMessage({ userMessage, technical }: { userMessage: string; technical: string }): string {
    // Use HTML for red border if supported by chat UI, otherwise fallback to Markdown blockquote with emoji
    return `
<div style="border:2px solid #e53935;padding:1em;border-radius:8px;background:#fff5f5;color:#b71c1c;margin:1em 0;">
  <strong>⚠️ ${userMessage}</strong>
  <details style="margin-top:0.5em;">
    <summary style="cursor:pointer;">Technical details</summary>
    <pre style="white-space:pre-wrap;font-size:0.95em;color:#333;background:#fbe9e7;padding:0.5em 1em;border-radius:4px;">${technical}</pre>
  </details>
</div>
`;
  }

  private async applyOllamaGrounding(
    response: string,
    executedToolNames: Set<string>,
    groundedVaultPaths: Set<string>,
    groundedJobIds: Set<string>,
    groundedMemoryIds: Set<string>,
  ): Promise<string> {
    if (!this.provider.getName().startsWith('ollama:')) {
      return response;
    }

    const groundingMode = OLLAMA_GROUNDING_MODE === 'off' || OLLAMA_GROUNDING_MODE === 'warn' || OLLAMA_GROUNDING_MODE === 'strict'
      ? OLLAMA_GROUNDING_MODE
      : 'warn';

    if (groundingMode === 'off') {
      return response;
    }

    const issues: string[] = [];

    const mentionedPaths = this.extractVaultMarkdownPaths(response);
    if (mentionedPaths.length > 0) {
      const usedVaultTools = executedToolNames.has('vault_search') || executedToolNames.has('vault_read');
      if (!usedVaultTools) {
        issues.push('vault paths were mentioned without vault tool output');
      } else if (groundedVaultPaths.size === 0) {
        issues.push('vault paths were mentioned but no grounded vault paths were captured');
      } else {
        const unverified = mentionedPaths.filter((path) => !groundedVaultPaths.has(path));
        if (unverified.length > 0) {
          issues.push('one or more vault paths were not present in vault tool output');
        }

        const missingOnDisk = await this.findMissingVaultPaths(mentionedPaths);
        if (missingOnDisk.length > 0) {
          issues.push('one or more mentioned vault paths do not exist on disk');
        }
      }
    }

    const mentionedJobIds = this.extractJobIds(response);
    if (mentionedJobIds.length > 0) {
      const usedJobTools = executedToolNames.has('job_run') || executedToolNames.has('job_status')
        || executedToolNames.has('job_list') || executedToolNames.has('job_cancel');
      if (!usedJobTools) {
        issues.push('job IDs were mentioned without job tool output');
      } else {
        const unverifiedJobs = mentionedJobIds.filter((id) => !groundedJobIds.has(id));
        if (unverifiedJobs.length > 0) {
          issues.push('one or more job IDs were not present in job tool output');
        }
      }
    }

    const mentionedMemoryIds = this.extractMemoryUuids(response);
    if (mentionedMemoryIds.length > 0) {
      const usedMemoryTools = executedToolNames.has('memory_remember') || executedToolNames.has('memory_recall')
        || executedToolNames.has('memory_forget');
      if (!usedMemoryTools) {
        issues.push('memory IDs were mentioned without memory tool output');
      } else {
        const unverifiedMemory = mentionedMemoryIds.filter((id) => !groundedMemoryIds.has(id));
        if (unverifiedMemory.length > 0) {
          issues.push('one or more memory IDs were not present in memory tool output');
        }
      }
    }

    if (issues.length === 0) {
      return response;
    }

    if (groundingMode === 'strict') {
      return 'I can’t verify parts of my previous response against tool output. Please let me run the relevant tool again.';
    }

    return `${response}\n\n[Grounding warning: some claims could not be verified from tool output in this turn.]`;
  }

  private async findMissingVaultPaths(paths: string[]): Promise<string[]> {
    const missing: string[] = [];
    for (const path of paths) {
      try {
        const fullPath = this.safeVaultPath(path);
        await readFile(fullPath, 'utf-8');
      } catch {
        missing.push(path);
      }
    }
    return missing;
  }

  private collectGroundedIds(
    toolName: string,
    toolResult: Record<string, unknown>,
    groundedJobIds: Set<string>,
    groundedMemoryIds: Set<string>,
  ): void {
    if (toolName === 'job_run' && typeof toolResult.jobId === 'string') {
      const id = this.normalizeJobId(toolResult.jobId);
      if (id) groundedJobIds.add(id);
    }

    if (toolName === 'job_status' && typeof toolResult.id === 'string') {
      const id = this.normalizeJobId(toolResult.id);
      if (id) groundedJobIds.add(id);
    }

    if (toolName === 'job_list' && Array.isArray(toolResult.jobs)) {
      for (const job of toolResult.jobs) {
        if (!job || typeof job !== 'object') continue;
        const maybeId = (job as Record<string, unknown>).id;
        if (typeof maybeId !== 'string') continue;
        const id = this.normalizeJobId(maybeId);
        if (id) groundedJobIds.add(id);
      }
    }

    if (toolName === 'job_cancel' && typeof toolResult.message === 'string') {
      for (const id of this.extractJobIds(toolResult.message)) {
        groundedJobIds.add(id);
      }
    }

    if ((toolName === 'memory_remember' || toolName === 'memory_forget') && typeof toolResult.id === 'string') {
      const id = this.normalizeMemoryUuid(toolResult.id);
      if (id) groundedMemoryIds.add(id);
    }

    if (toolName === 'memory_recall' && Array.isArray(toolResult.memories)) {
      for (const memory of toolResult.memories) {
        if (!memory || typeof memory !== 'object') continue;
        const maybeId = (memory as Record<string, unknown>).id;
        if (typeof maybeId !== 'string') continue;
        const id = this.normalizeMemoryUuid(maybeId);
        if (id) groundedMemoryIds.add(id);
      }
    }
  }

  private collectGroundedVaultPaths(
    toolName: string,
    toolResult: Record<string, unknown>,
    groundedVaultPaths: Set<string>,
  ): void {
    if (toolName === 'vault_read') {
      const path = typeof toolResult.path === 'string' ? this.normalizeVaultPath(toolResult.path) : undefined;
      if (path) groundedVaultPaths.add(path);
      return;
    }

    if (toolName === 'vault_search') {
      const results = Array.isArray(toolResult.results)
        ? toolResult.results
        : [];
      for (const row of results) {
        if (!row || typeof row !== 'object') continue;
        const maybePath = (row as Record<string, unknown>).path;
        if (typeof maybePath === 'string') {
          const path = this.normalizeVaultPath(maybePath);
          if (path) groundedVaultPaths.add(path);
        }
      }
    }
  }

  private extractVaultMarkdownPaths(text: string): string[] {
    const matches = text.match(/(?:^|[^A-Za-z0-9._\/-])([A-Za-z0-9._\/-]+\.md)(?=$|[^A-Za-z0-9._\/-])/g) ?? [];
    const normalized = matches
      .map((raw) => raw.trim().replace(/^[^A-Za-z0-9._\/-]+/, ''))
      .map((value) => this.normalizeVaultPath(value))
      .filter((value): value is string => Boolean(value));
    return [...new Set(normalized)];
  }

  private normalizeVaultPath(value: string): string | undefined {
    const normalized = value.trim().replace(/^\.\//, '');
    if (!normalized.toLowerCase().endsWith('.md')) return undefined;
    if (normalized.includes('..')) return undefined;
    return normalized;
  }

  private extractJobIds(text: string): string[] {
    const matches = text.match(/\b(job_[A-Za-z0-9_-]{8,})\b/g) ?? [];
    const normalized = matches
      .map((value) => this.normalizeJobId(value))
      .filter((value): value is string => Boolean(value));
    return [...new Set(normalized)];
  }

  private normalizeJobId(value: string): string | undefined {
    const normalized = value.trim();
    if (!/^job_[A-Za-z0-9_-]{8,}$/.test(normalized)) return undefined;
    return normalized;
  }

  private extractMemoryUuids(text: string): string[] {
    const matches = text.match(/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\b/g) ?? [];
    const normalized = matches
      .map((value) => this.normalizeMemoryUuid(value))
      .filter((value): value is string => Boolean(value));
    return [...new Set(normalized)];
  }

  private normalizeMemoryUuid(value: string): string | undefined {
    const normalized = value.trim().toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)) {
      return undefined;
    }
    return normalized;
  }
}
