import { createLogger } from '@jonas/shared/utils';
import type { MemoryCategory } from '@jonas/shared/types';
import type { MemoryClient } from './client.js';
import type { EmbeddingClient } from './embeddings.js';

const log = createLogger('memory-extractor');

interface ExtractedMemory {
  category: MemoryCategory;
  content: string;
}

export class MemoryExtractor {
  constructor(
    private memory: MemoryClient,
    private embeddings: EmbeddingClient
  ) {}

  async extractFromTurn(userMessage: string, assistantResponse: string): Promise<void> {
    try {
      const memories = this.extractHeuristic(userMessage, assistantResponse);

      if (memories.length === 0) {
        return;
      }

      const contents = memories.map((m) => m.content);
      const vectors = await this.embeddings.embed(contents);

      for (let i = 0; i < memories.length; i++) {
        await this.memory.upsert(
          memories[i].category,
          memories[i].content,
          vectors[i],
          { userMessage: userMessage.slice(0, 200) },
          'auto'
        );
      }

      log.info({ count: memories.length }, 'Auto-extracted memories');
    } catch (err) {
      log.warn(err, 'Memory extraction failed');
    }
  }

  /**
   * Heuristic extraction — looks for patterns indicating memorable info.
   * Phase 3 will add Claude Haiku-based extraction for better quality.
   */
  private extractHeuristic(user: string, _assistant: string): ExtractedMemory[] {
    const memories: ExtractedMemory[] = [];
    const lower = user.toLowerCase();

    // Preference patterns
    const prefPatterns = [
      /i (?:prefer|like|love|want|use|always)\s+(.+)/i,
      /my (?:name|favorite|preferred)\s+(?:is|are)\s+(.+)/i,
      /(?:call me|i'm called)\s+(.+)/i,
    ];
    for (const pattern of prefPatterns) {
      const match = user.match(pattern);
      if (match) {
        memories.push({
          category: 'semantic',
          content: `User preference: ${user.trim()}`,
        });
        break;
      }
    }

    // Decision patterns
    if (lower.includes('decided') || lower.includes('going with') || lower.includes('chose')) {
      memories.push({
        category: 'episodic',
        content: `Decision: ${user.trim()}`,
      });
    }

    // Instruction patterns
    if (lower.includes('remember that') || lower.includes('keep in mind') || lower.includes('note that')) {
      memories.push({
        category: 'semantic',
        content: user.trim(),
      });
    }

    return memories;
  }
}
