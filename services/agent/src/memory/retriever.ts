import { createLogger } from '@jonas/shared/utils';
import type { MemorySearchResult } from '@jonas/shared/types';
import type { MemoryClient } from './client.js';
import type { EmbeddingClient } from './embeddings.js';

const log = createLogger('memory-retriever');

const DEFAULT_LIMIT = 8;
const MIN_SCORE = 0.3;

export class MemoryRetriever {
  constructor(
    private memory: MemoryClient,
    private embeddings: EmbeddingClient
  ) {}

  async retrieve(query: string, limit = DEFAULT_LIMIT): Promise<MemorySearchResult[]> {
    try {
      const embedding = await this.embeddings.embedQuery(query);
      const results = await this.memory.search('all', embedding, limit);

      // Filter out low-relevance results
      const filtered = results.filter((r) => r.score >= MIN_SCORE);

      log.info(
        { query: query.slice(0, 50), total: results.length, relevant: filtered.length },
        'Retrieved memories'
      );

      return filtered;
    } catch (err) {
      log.warn(err, 'Memory retrieval failed, continuing without context');
      return [];
    }
  }
}
