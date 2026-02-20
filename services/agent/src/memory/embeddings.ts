import { createLogger } from '@jonas/shared/utils';

const log = createLogger('embeddings');

const VOYAGE_API_URL = 'https://api.voyageai.com/v1/embeddings';
const MODEL = 'voyage-3-large';
const DIMENSIONS = 1024;
const REQUEST_TIMEOUT_MS = Number(process.env.VOYAGE_TIMEOUT_MS ?? 15000);

export class EmbeddingClient {
  private apiKey: string;

  constructor() {
    this.apiKey = process.env.VOYAGE_API_KEY ?? '';
    if (!this.apiKey) {
      log.warn('VOYAGE_API_KEY not set — embeddings will fail');
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!this.apiKey) {
      throw new Error('VOYAGE_API_KEY not configured');
    }

    const response = await this.fetchWithTimeout({
      model: MODEL,
      input: texts,
      input_type: 'document',
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Voyage API error: ${response.status} ${error}`);
    }

    const data = (await response.json()) as {
      data: { embedding: number[] }[];
    };

    return data.data.map((d) => d.embedding);
  }

  async embedQuery(text: string): Promise<number[]> {
    if (!this.apiKey) {
      throw new Error('VOYAGE_API_KEY not configured');
    }

    const response = await this.fetchWithTimeout({
      model: MODEL,
      input: [text],
      input_type: 'query',
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Voyage API error: ${response.status} ${error}`);
    }

    const data = (await response.json()) as {
      data: { embedding: number[] }[];
    };

    return data.data[0].embedding;
  }

  get dimensions(): number {
    return DIMENSIONS;
  }

  private async fetchWithTimeout(payload: Record<string, unknown>): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      return await fetch(VOYAGE_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err: unknown) {
      if ((err as Error).name === 'AbortError') {
        throw new Error(`Voyage API timeout after ${REQUEST_TIMEOUT_MS}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
}
