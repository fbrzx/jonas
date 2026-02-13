// Memory tools are now defined in mcp-server.ts as a standalone MCP server.
// This file only exports the MemoryToolDeps type for backwards compatibility.

import type { MemoryClient } from '../memory/client.js';
import type { EmbeddingClient } from '../memory/embeddings.js';

export interface MemoryToolDeps {
  memory: MemoryClient;
  embeddings: EmbeddingClient;
}
