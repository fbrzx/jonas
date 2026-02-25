import { randomUUID } from 'node:crypto';
import { QdrantClient } from '@qdrant/js-client-rest';
import { createLogger, isoNow } from '@jonas/shared/utils';
import type { Memory, MemoryCategory, MemorySearchResult } from '@jonas/shared/types';

const log = createLogger('memory-client');

const COLLECTIONS: MemoryCategory[] = ['episodic', 'semantic', 'procedural'];
const VECTOR_SIZE = 1024; // voyage-3-large

export class MemoryClient {
  private client: QdrantClient;

  constructor() {
    const url = process.env.QDRANT_URL ?? 'http://localhost:6333';
    this.client = new QdrantClient({ url });
    log.info({ url }, 'Qdrant client initialized');
  }

  async ensureCollections(): Promise<void> {
    for (const name of COLLECTIONS) {
      const collectionName = `memory_${name}`;
      try {
        await this.client.getCollection(collectionName);
        log.info({ collection: collectionName }, 'Collection exists');
      } catch {
        await this.client.createCollection(collectionName, {
          vectors: { size: VECTOR_SIZE, distance: 'Cosine' },
        });
        log.info({ collection: collectionName }, 'Collection created');
      }
    }
  }

  async upsert(
    category: MemoryCategory,
    content: string,
    embedding: number[],
    metadata: Record<string, unknown> = {},
    source: Memory['source'] = 'agent'
  ): Promise<string> {
    const id = randomUUID();
    const now = isoNow();

    await this.client.upsert(`memory_${category}`, {
      wait: true,
      points: [
        {
          id,
          vector: embedding,
          payload: {
            content,
            category,
            metadata,
            source,
            createdAt: now,
            updatedAt: now,
          },
        },
      ],
    });

    log.info({ id, category, source }, 'Memory stored');
    return id;
  }

  async search(
    category: MemoryCategory | 'all',
    embedding: number[],
    limit = 5
  ): Promise<MemorySearchResult[]> {
    const categories = category === 'all' ? COLLECTIONS : [category];
    const results: MemorySearchResult[] = [];

    for (const cat of categories) {
      const searchResult = await this.client.search(`memory_${cat}`, {
        vector: embedding,
        limit,
        with_payload: true,
      });

      for (const point of searchResult) {
        const payload = point.payload as Record<string, unknown>;
        results.push({
          memory: {
            id: point.id as string,
            category: cat,
            content: payload.content as string,
            metadata: (payload.metadata as Record<string, unknown>) ?? {},
            source: (payload.source as Memory['source']) ?? 'agent',
            createdAt: payload.createdAt as string,
            updatedAt: payload.updatedAt as string,
          },
          score: point.score,
        });
      }
    }

    // Sort by score descending across all categories
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  async delete(category: MemoryCategory, id: string): Promise<void> {
    await this.client.delete(`memory_${category}`, {
      wait: true,
      points: [id],
    });
    log.info({ id, category }, 'Memory deleted');
  }

  async count(category: MemoryCategory): Promise<number> {
    const info = await this.client.getCollection(`memory_${category}`);
    return info.points_count ?? 0;
  }

  async allWithVectors(limit = 60): Promise<Array<{ memory: Memory; vector: number[] }>> {
    const all: Array<{ memory: Memory; vector: number[] }> = [];
    const perCategory = Math.ceil(limit / COLLECTIONS.length);

    for (const category of COLLECTIONS) {
      const result = await this.client.scroll(`memory_${category}`, {
        limit: perCategory,
        with_payload: true,
        with_vector: true,
      });

      for (const point of result.points ?? []) {
        const payload = point.payload as Record<string, unknown>;
        const rawVector = point.vector;
        if (!Array.isArray(rawVector)) continue;

        const createdAt = String(payload.createdAt ?? '');
        if (!createdAt) continue;

        all.push({
          memory: {
            id: String(point.id),
            category,
            content: String(payload.content ?? ''),
            metadata: (payload.metadata as Record<string, unknown>) ?? {},
            source: (payload.source as Memory['source']) ?? 'agent',
            createdAt,
            updatedAt: String(payload.updatedAt ?? createdAt),
          },
          vector: rawVector as number[],
        });
      }
    }

    return all.slice(0, limit);
  }

  async latest(limit = 5): Promise<Memory[]> {
    const all: Memory[] = [];

    for (const category of COLLECTIONS) {
      const result = await this.client.scroll(`memory_${category}`, {
        limit: Math.max(limit * 4, 20),
        with_payload: true,
        with_vector: false,
      });

      for (const point of result.points ?? []) {
        const payload = point.payload as Record<string, unknown>;
        const createdAt = String(payload.createdAt ?? '');
        if (!createdAt) continue;

        all.push({
          id: String(point.id),
          category,
          content: String(payload.content ?? ''),
          metadata: (payload.metadata as Record<string, unknown>) ?? {},
          source: (payload.source as Memory['source']) ?? 'agent',
          createdAt,
          updatedAt: String(payload.updatedAt ?? createdAt),
        });
      }
    }

    all.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return all.slice(0, limit);
  }
}
