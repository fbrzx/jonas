/**
 * Provider factory - loads configuration and creates appropriate provider.
 */

import { readFile } from 'node:fs/promises';
import { createLogger } from '@jonas/shared/utils';
import type { ModelProvider, ProviderConfig } from './base.js';
import { ClaudeProvider } from './claude.js';
import { OllamaProvider } from './ollama.js';

const log = createLogger('provider-factory');

export class ProviderFactory {
  /**
   * Load provider configuration from file and environment variables.
   * Priority: file overrides env vars.
   *
   * @param configPath Path to model-config.json (optional)
   * @returns Provider configuration
   */
  static async loadConfig(configPath?: string): Promise<ProviderConfig> {
    let fileConfig: Partial<ProviderConfig> | null = null;

    // Try to load from file if path provided
    if (configPath) {
      try {
        const content = await readFile(configPath, 'utf-8');
        fileConfig = JSON.parse(content);
        log.info({ configPath }, 'Loaded model config from file');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          log.warn(err, 'Failed to load model config file');
        }
      }
    }

    // Get defaults from env vars
    const provider = (fileConfig?.provider ?? process.env.MODEL_PROVIDER ?? 'claude') as 'claude' | 'ollama';

    const claudeModel = fileConfig?.claude?.model
      ?? process.env.CLAUDE_MODEL
      ?? process.env.AGENT_DEFAULT_MODEL
      ?? 'claude-sonnet-4-5-20250929';

    const ollamaBaseUrl = fileConfig?.ollama?.baseUrl ?? process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
    const ollamaModel = fileConfig?.ollama?.model ?? process.env.OLLAMA_MODEL ?? 'qwen2.5-coder:latest';

    const config: ProviderConfig = {
      provider,
      claude: { model: claudeModel },
      ollama: { baseUrl: ollamaBaseUrl, model: ollamaModel },
    };

    log.info({ provider, config }, 'Model provider configuration loaded');
    return config;
  }

  /**
   * Create the appropriate provider based on configuration.
   *
   * @param config Provider configuration
   * @param claudeBin Path to Claude binary (required for Claude provider)
   * @param mcpConfigPath Path to MCP config file (required for Claude provider)
   * @returns Configured model provider
   */
  static create(config: ProviderConfig, claudeBin: string, mcpConfigPath: string): ModelProvider {
    if (config.provider === 'ollama') {
      if (!config.ollama) {
        throw new Error('Ollama configuration missing');
      }
      log.info({ baseUrl: config.ollama.baseUrl, model: config.ollama.model }, 'Creating Ollama provider');
      return new OllamaProvider(config.ollama.baseUrl, config.ollama.model);
    }

    // Default to Claude
    log.info({ claudeBin, model: config.claude?.model }, 'Creating Claude provider');
    return new ClaudeProvider(claudeBin, mcpConfigPath, config.claude?.model ?? 'claude-sonnet-4-5-20250929');
  }
}
