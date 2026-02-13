import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createLogger, createId, isoNow } from '@jonas/shared/utils';
import type { Message, Conversation, Channel, AuditEntry } from '@jonas/shared/types';
import { SessionManager } from './session.js';
import { assembleSystemPrompt } from './prompt.js';
import type { MemoryRetriever } from '../memory/retriever.js';
import type { MemoryExtractor } from '../memory/extractor.js';
import type { SkillRegistry } from '../skills/registry.js';

const log = createLogger('agent-core');

export interface AgentCoreOptions {
  retriever: MemoryRetriever;
  extractor: MemoryExtractor;
  claudeBin: string;
  mcpConfigPath: string;
  skillRegistry?: SkillRegistry;
}

interface CliResult {
  type: string;
  subtype: string;
  is_error: boolean;
  result: string;
  duration_ms: number;
}

export class AgentCore {
  private sessions = new SessionManager();
  private retriever: MemoryRetriever;
  private extractor: MemoryExtractor;
  private claudeBin: string;
  private mcpConfigPath: string;
  private skillRegistry?: SkillRegistry;
  private auditLog: AuditEntry[] = [];
  private startedAt = Date.now();
  private abortControllers = new Map<string, AbortController>();

  constructor(opts: AgentCoreOptions) {
    this.retriever = opts.retriever;
    this.extractor = opts.extractor;
    this.claudeBin = opts.claudeBin;
    this.mcpConfigPath = opts.mcpConfigPath;
    this.skillRegistry = opts.skillRegistry;
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

  async chat(
    userMessage: string,
    channel: Channel,
    sessionKey?: string,
    onDelta?: (text: string) => void,
    onToolUse?: (name: string, input: Record<string, unknown>) => void
  ): Promise<string> {
    const key = sessionKey ?? `${channel.type}:${channel.id}`;
    const session = this.sessions.getOrCreate(key);

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
      log.info({ channel: channel.type, sessionKey: key, historyLen: session.messages.length }, 'Sending query to Claude CLI');

      fullResponse = await this.spawnClaude({
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
        log.error(err, 'Claude query failed');
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

  private spawnClaude(opts: {
    prompt: string;
    systemPrompt: string;
    model: string;
    signal: AbortSignal;
  }): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = [
        '--print',
        '--output-format', 'json',
        '--model', opts.model,
        '--max-turns', '10',
        '--system-prompt', opts.systemPrompt,
        '--permission-mode', 'bypassPermissions',
        '--mcp-config', this.mcpConfigPath,
        '--', opts.prompt,
      ];

      const child = spawn(this.claudeBin, args, {
        env: { ...process.env, CLAUDECODE: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
      child.stderr.on('data', (data: Buffer) => {
        const line = data.toString().trim();
        if (line) log.warn({ stderr: line }, 'Claude CLI stderr');
        stderr += line;
      });

      const onAbort = () => {
        child.kill('SIGTERM');
        reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
      };
      opts.signal.addEventListener('abort', onAbort, { once: true });

      child.on('close', (code) => {
        opts.signal.removeEventListener('abort', onAbort);
        log.info({ code, stdoutLen: stdout.length }, 'Claude CLI process exited');

        try {
          const result: CliResult = JSON.parse(stdout);
          if (result.is_error) {
            log.error({ result: result.result }, 'Claude CLI returned error');
            reject(new Error(result.result));
            return;
          }
          log.info({ duration: result.duration_ms }, 'Claude CLI response received');
          resolve(result.result);
        } catch {
          if (code !== 0) {
            reject(new Error(`Claude CLI exited with code ${code}: ${stderr || stdout}`));
          } else {
            resolve(stdout.trim());
          }
        }
      });

      child.on('error', (err) => {
        opts.signal.removeEventListener('abort', onAbort);
        reject(err);
      });
    });
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
  }
}
