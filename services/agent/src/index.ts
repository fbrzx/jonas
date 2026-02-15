import { writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '@jonas/shared/utils';
import { AgentCore } from './agent/core.js';
import { ProviderFactory } from './agent/providers/factory.js';
import { MemoryClient } from './memory/client.js';
import { EmbeddingClient } from './memory/embeddings.js';
import { MemoryRetriever } from './memory/retriever.js';
import { MemoryExtractor } from './memory/extractor.js';
import { createApiServer } from './api/server.js';
import { TaskScheduler } from './tasks/scheduler.js';
import { SkillRegistry } from './skills/registry.js';
import { SkillCryptoStore } from './skills/crypto-store.js';
import { OAuthProviderStore } from './oauth/provider-store.js';
import { OAuthHandler } from './oauth/handler.js';
import { ConversationDatabase } from './storage/database.js';

const log = createLogger('jonas');

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  log.info('Starting Jonas agent...');

  // Initialize memory subsystem
  const embeddings = new EmbeddingClient();
  const memory = new MemoryClient();
  await memory.ensureCollections();
  const retriever = new MemoryRetriever(memory, embeddings);
  const extractor = new MemoryExtractor(memory, embeddings);

  // Resolve paths for Claude CLI and MCP server
  const mcpServerPath = resolve(__dirname, 'mcp-server.js');
  const mcpConfigPath = '/data/mcp-config.json';

  // Find the claude binary — installed via @anthropic-ai/claude-code
  const claudeBin = resolve(__dirname, '..', 'node_modules', '.bin', 'claude');

  // Write MCP config for the claude CLI to discover our tools server
  const mcpConfig = {
    mcpServers: {
      jonas: {
        command: 'node',
        args: [mcpServerPath],
        env: {
          QDRANT_URL: process.env.QDRANT_URL ?? 'http://localhost:6333',
          VOYAGE_API_KEY: process.env.VOYAGE_API_KEY ?? '',
          VAULT_PATH: process.env.VAULT_PATH ?? '/data/vault',
        },
      },
    },
  };
  await writeFile(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));
  log.info({ mcpConfigPath, claudeBin }, 'MCP config written');

  // Initialize skill registry
  const skillCrypto = new SkillCryptoStore();
  const skillRegistry = new SkillRegistry(skillCrypto);
  await skillRegistry.load();
  log.info({ skills: skillRegistry.list().length }, 'Skill registry loaded');

  // Initialize OAuth
  const oauthProviderStore = new OAuthProviderStore(skillCrypto);
  await oauthProviderStore.load();
  const oauthHandler = new OAuthHandler({ providerStore: oauthProviderStore, skillRegistry });
  log.info('OAuth provider store loaded');

  // Load model provider configuration and create provider
  const modelConfigPath = '/data/model-config.json';
  const providerConfig = await ProviderFactory.loadConfig(modelConfigPath);
  const provider = ProviderFactory.create(providerConfig, claudeBin, mcpConfigPath);
  log.info({ provider: provider.getName() }, 'Model provider initialized');

  // Initialize conversation database
  const dbPath = process.env.DB_PATH ?? '/data/conversations.db';
  const database = new ConversationDatabase(dbPath);

  // Initialize agent core
  const agent = new AgentCore({ retriever, extractor, provider, mcpConfigPath, skillRegistry, database });

  // Initialize task scheduler
  const scheduler = new TaskScheduler({
    agent,
    dispatchOutput: async (channel, text) => {
      log.info({ channel, textLen: text.length }, 'Task output (no delivery channel configured)');
    },
    storagePath: '/data/tasks.json',
  });
  await scheduler.start();
  log.info('Task scheduler started');

  // Start internal API server
  const api = createApiServer({ agent, memory, retriever, scheduler, skillRegistry, oauthProviderStore, oauthHandler, database });
  const port = Number(process.env.AGENT_PORT ?? 3001);

  const { serve } = await import('@hono/node-server');
  serve({ fetch: api.fetch, port }, () => {
    log.info(`API server listening on :${port}`);
  });

  log.info('Jonas agent ready');

  // Graceful shutdown
  const shutdown = async () => {
    log.info('Shutting down...');
    scheduler.stop();
    database.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  log.error(err, 'Fatal error starting Jonas');
  process.exit(1);
});
