/**
 * Claude provider - wraps Claude CLI subprocess invocation.
 */

import { spawn } from 'node:child_process';
import { createLogger } from '@jonas/shared/utils';
import type { ModelProvider, QueryOptions } from './base.js';

const log = createLogger('provider-claude');

interface CliResult {
  type: string;
  subtype: string;
  is_error: boolean;
  result: string;
  duration_ms: number;
}

export class ClaudeProvider implements ModelProvider {
  private claudeBin: string;
  private mcpConfigPath: string;

  constructor(claudeBin: string, mcpConfigPath: string) {
    this.claudeBin = claudeBin;
    this.mcpConfigPath = mcpConfigPath;
  }

  getName(): string {
    // Extract model name from env or use default
    const model = process.env.AGENT_DEFAULT_MODEL ?? 'claude-sonnet-4-5-20250929';
    return `claude:${model}`;
  }

  query(opts: QueryOptions): Promise<string> {
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
}
