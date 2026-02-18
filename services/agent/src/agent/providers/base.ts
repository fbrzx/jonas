/**
 * Base provider interface for model abstraction.
 * Allows switching between Claude CLI and Ollama API.
 */

export interface ModelProvider {
  /**
   * Query the model with a prompt and return the response.
   * @param opts Query options including prompt, system prompt, and abort signal
   * @returns The model's response text
   */
  query(opts: QueryOptions): Promise<string>;

  /**
   * Get the provider name for status reporting.
   * @returns Provider name (e.g., "claude:sonnet-4-5" or "ollama:qwen2.5-coder")
   */
  getName(): string;
}

export interface QueryOptions {
  prompt: string;
  systemPrompt: string;
  model?: string;
  signal: AbortSignal;
}

/**
 * Configuration schema for model providers.
 */
export interface ProviderConfig {
  /** Which provider to use: "claude" or "ollama" */
  provider: 'claude' | 'ollama';

  /** Claude-specific configuration */
  claude?: {
    model: string;
  };

  /** Ollama-specific configuration */
  ollama?: {
    baseUrl: string;
    model: string;
  };
}
