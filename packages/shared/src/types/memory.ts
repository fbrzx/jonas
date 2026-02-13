export type MemoryCategory = 'episodic' | 'semantic' | 'procedural';

export interface Memory {
  id: string;
  category: MemoryCategory;
  content: string;
  metadata: Record<string, unknown>;
  embedding?: number[];
  createdAt: string;
  updatedAt: string;
  source: 'auto' | 'manual' | 'agent';
}

export interface MemorySearchResult {
  memory: Memory;
  score: number;
}
