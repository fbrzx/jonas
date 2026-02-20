/**
 * Ollama provider - HTTP client for Ollama REST API.
 */

import { createLogger } from '@jonas/shared/utils';
import type {
  ModelProvider,
  ProviderMessage,
  ProviderTool,
  ProviderToolCall,
  QueryOptions,
  QueryResult,
} from './base.js';

const log = createLogger('provider-ollama');

interface OllamaChatRequest {
  model: string;
  messages: OllamaMessage[];
  stream: boolean;
  tools?: Array<{
    type: 'function';
    function: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    };
  }>;
}

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  tool_calls?: Array<{
    function: {
      name: string;
      arguments: Record<string, unknown> | string;
    };
  }>;
}

interface OllamaChatResponse {
  model: string;
  created_at: string;
  message: {
    role: string;
    content: string;
    tool_calls?: Array<{
      function: {
        name: string;
        arguments: Record<string, unknown> | string;
      };
    }>;
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

  async query(opts: QueryOptions): Promise<QueryResult> {
    const url = `${this.baseUrl}/api/chat`;

    const messages = opts.messages && opts.messages.length > 0
      ? this.toOllamaMessages(opts.messages)
      : [
        { role: 'system' as const, content: opts.systemPrompt },
        { role: 'user' as const, content: opts.prompt },
      ];

    const requestBody: OllamaChatRequest = {
      model: this.model,
      messages,
      stream: false,
      tools: this.toOllamaTools(opts.tools),
    };

    try {
      log.info({ url, model: this.model }, 'Sending request to Ollama');

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

      if (!data.message) {
        log.error({ data }, 'Unexpected Ollama response format');
        throw new Error('Ollama response missing message');
      }

      const toolsEnabled = Boolean(opts.tools && opts.tools.length > 0);
      const structuredToolCalls = toolsEnabled ? this.parseToolCalls(data.message.tool_calls) : [];
      const text = data.message.content ?? '';
      const fallbackToolCalls = toolsEnabled && structuredToolCalls.length === 0
        ? this.parseToolCallsFromText(text)
        : [];
      const toolCalls = [...structuredToolCalls, ...fallbackToolCalls];
      const responseText = toolCalls.length > 0 && fallbackToolCalls.length > 0
        ? ''
        : text;

      log.info(
        {
          model: data.model,
          contentLen: responseText.length,
          toolCalls: toolCalls.length,
        },
        'Ollama response received',
      );
      return {
        text: responseText,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      };

    } catch (err: unknown) {
      if ((err as Error).name === 'AbortError') {
        log.info('Ollama query aborted');
        throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
      }

      log.error(err, 'Ollama query failed');
      throw err;
    }
  }

  private toOllamaTools(tools?: ProviderTool[]): OllamaChatRequest['tools'] {
    if (!tools || tools.length === 0) return undefined;
    return tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  private toOllamaMessages(messages: ProviderMessage[]): OllamaMessage[] {
    return messages.map((message) => {
      const mapped: OllamaMessage = {
        role: message.role,
        content: message.content,
      };

      if (message.name) {
        mapped.name = message.name;
      }

      if (message.toolCalls && message.toolCalls.length > 0) {
        mapped.tool_calls = message.toolCalls.map((toolCall) => ({
          function: {
            name: toolCall.name,
            arguments: toolCall.input,
          },
        }));
      }

      return mapped;
    });
  }

  private parseToolCalls(raw?: OllamaMessage['tool_calls']): ProviderToolCall[] {
    if (!raw || raw.length === 0) return [];

    return raw
      .map((call, index) => {
        const name = call.function?.name;
        const args = call.function?.arguments;

        if (!name) return null;

        let input: Record<string, unknown> = {};
        if (typeof args === 'string') {
          try {
            input = JSON.parse(args) as Record<string, unknown>;
          } catch {
            input = {};
          }
        } else if (args && typeof args === 'object') {
          input = args;
        }

        return {
          id: `tool_${Date.now()}_${index}`,
          name,
          input,
        };
      })
      .filter((call): call is ProviderToolCall => call !== null);
  }

  private parseToolCallsFromText(text: string): ProviderToolCall[] {
    const trimmed = text.trim();
    if (!trimmed) return [];

    const candidates: string[] = [trimmed];

    const fencedMatches = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
    for (const match of fencedMatches) {
      if (match[1]) candidates.push(match[1].trim());
    }

    const objectLike = trimmed.match(/\{[\s\S]*\}/);
    if (objectLike?.[0]) candidates.push(objectLike[0].trim());

    const arrayLike = trimmed.match(/\[[\s\S]*\]/);
    if (arrayLike?.[0]) candidates.push(arrayLike[0].trim());

    for (const candidate of candidates) {
      const parsed = this.tryParseToolCallCandidate(candidate);
      if (parsed.length > 0) {
        log.info({ toolCalls: parsed.length }, 'Parsed tool calls from text fallback');
        return parsed;
      }
    }

    return [];
  }

  private tryParseToolCallCandidate(candidate: string): ProviderToolCall[] {
    let data: unknown;
    try {
      data = JSON.parse(candidate);
    } catch {
      const tolerant = this.tryParseToolCallLoosely(candidate);
      return tolerant ? [tolerant] : [];
    }

    const normalize = (item: unknown, index: number): ProviderToolCall | null => {
      if (!item || typeof item !== 'object') return null;
      const obj = item as Record<string, unknown>;

      const name = typeof obj.name === 'string'
        ? obj.name
        : (typeof obj.tool === 'string' ? obj.tool : undefined);
      if (!name) return null;

      const rawArgs = obj.arguments ?? obj.input ?? {};
      const input = rawArgs && typeof rawArgs === 'object'
        ? rawArgs as Record<string, unknown>
        : {};

      return {
        id: `tool_text_${Date.now()}_${index}`,
        name,
        input,
      };
    };

    if (Array.isArray(data)) {
      return data
        .map((item, index) => normalize(item, index))
        .filter((call): call is ProviderToolCall => call !== null);
    }

    const single = normalize(data, 0);
    return single ? [single] : [];
  }

  private tryParseToolCallLoosely(candidate: string): ProviderToolCall | null {
    const nameMatch = candidate.match(/["']?name["']?\s*:\s*["']([^"']+)["']/i);
    if (!nameMatch?.[1]) return null;

    const argsIndexMatch = candidate.match(/["']?(arguments|input)["']?\s*:/i);
    let input: Record<string, unknown> = {};

    if (argsIndexMatch?.index !== undefined) {
      const afterColon = candidate.slice(argsIndexMatch.index + argsIndexMatch[0].length);
      const jsonObjectText = this.extractFirstBalancedObject(afterColon);
      if (jsonObjectText) {
        const normalized = jsonObjectText.replace(/,\s*([}\]])/g, '$1');
        try {
          const parsed = JSON.parse(normalized);
          if (parsed && typeof parsed === 'object') {
            input = parsed as Record<string, unknown>;
          }
        } catch {
          input = {};
        }
      }
    }

    return {
      id: `tool_loose_${Date.now()}`,
      name: nameMatch[1],
      input,
    };
  }

  private extractFirstBalancedObject(text: string): string | null {
    const start = text.indexOf('{');
    if (start === -1) return null;

    let depth = 0;
    for (let i = start; i < text.length; i++) {
      const char = text[i];
      if (char === '{') depth++;
      if (char === '}') {
        depth--;
        if (depth === 0) {
          return text.slice(start, i + 1);
        }
      }
    }

    return null;
  }
}
