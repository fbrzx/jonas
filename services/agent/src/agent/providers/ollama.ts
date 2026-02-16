/**
 * Ollama provider - HTTP client for Ollama REST API.
 */

import { createLogger } from '@jonas/shared/utils';
import type { ModelProvider, QueryOptions } from './base.js';

const log = createLogger('provider-ollama');

interface OllamaChatRequest {
  model: string;
  messages: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string;
  }>;
  stream: boolean;
}

interface OllamaChatResponse {
  model: string;
  created_at: string;
  message: {
    role: string;
    content: string;
  };
  done: boolean;
}

export class OllamaProvider implements ModelProvider {
  private baseUrl: string;
  private model: string;

  constructor(baseUrl: string, model: string) {
    this.baseUrl = baseUrl.replace(/\/$/, ''); // Remove trailing slash
    this.model = model;
  }

  getName(): string {
    return `ollama:${this.model}`;
  }

  async query(opts: QueryOptions): Promise<string> {
    const url = `${this.baseUrl}/api/chat`;

    const requestBody: OllamaChatRequest = {
      model: opts.model,
      messages: [
        { role: 'system', content: opts.systemPrompt },
        { role: 'user', content: opts.prompt },
      ],
      stream: false,
    };

    try {
      log.info({ url, model: opts.model }, 'Sending request to Ollama');

      const controller = new AbortController();

      // Forward abort signal
      const onAbort = () => controller.abort();
      opts.signal.addEventListener('abort', onAbort, { once: true });

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      opts.signal.removeEventListener('abort', onAbort);

      if (!response.ok) {
        const errorText = await response.text();
        log.error({ status: response.status, error: errorText }, 'Ollama API error');
        throw new Error(`Ollama API error (${response.status}): ${errorText}`);
      }

      const data = (await response.json()) as OllamaChatResponse;

      if (!data.message?.content) {
        log.error({ data }, 'Unexpected Ollama response format');
        throw new Error('Ollama response missing message content');
      }

      log.info({ model: data.model, contentLen: data.message.content.length }, 'Ollama response received');
      return data.message.content;

    } catch (err: unknown) {
      if ((err as Error).name === 'AbortError') {
        log.info('Ollama query aborted');
        throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
      }

      log.error(err, 'Ollama query failed');
      throw err;
    }
  }
}
