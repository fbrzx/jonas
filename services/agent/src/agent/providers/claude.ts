/**
 * Claude provider - wraps Claude CLI subprocess invocation.
 */

import { spawn } from 'node:child_process';
import { createLogger } from '@jonas/shared/utils';
import type { ModelProvider, QueryOptions, QueryResult } from './base.js';

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
  private model: string;

  constructor(claudeBin: string, mcpConfigPath: string, model: string) {
    this.claudeBin = claudeBin;
    this.mcpConfigPath = mcpConfigPath;
    this.model = model;
  }

  getName(): string {
    return `claude:${this.model}`;
  }

  query(opts: QueryOptions): Promise<QueryResult> {
    return new Promise((resolve, reject) => {
      const model = opts.model ?? this.model;
      const args = [
        '--print',
        '--output-format', 'json',
        '--model', model,
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
        log.info({ code, stdoutLen: stdout.length, stderrLen: stderr.length }, 'Claude CLI process exited');

        try {
          const result: CliResult = JSON.parse(stdout);
          if (result.is_error) {
            log.error({ result: result.result }, 'Claude CLI returned error');
            reject(new Error(result.result));
            return;
          }
          log.info({ duration: result.duration_ms }, 'Claude CLI response received');
          resolve({ text: result.result });
        } catch {
          if (code !== 0) {
            // Try to extract useful error info from stderr
            const errorDetail = stderr || stdout || 'Unknown error';
            const trimmedError = errorDetail.substring(0, 500); // Limit error length
            reject(new Error(`Claude CLI exited with code ${code}: ${trimmedError}`));
          } else {
            resolve({ text: stdout.trim() });
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
