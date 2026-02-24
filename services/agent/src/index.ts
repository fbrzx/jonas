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
import { BackgroundJobManager } from './tasks/job-manager.js';
import { SkillRegistry } from './skills/registry.js';
import { SkillCryptoStore } from './skills/crypto-store.js';
import { OAuthProviderStore } from './oauth/provider-store.js';
import { OAuthHandler } from './oauth/handler.js';
import { ConversationDatabase } from './storage/database.js';
import { ChannelRegistry } from './channels/registry.js';
import { ChannelPairingService } from './channels/pairing.js';
import { ConnectionManager } from './connections/manager.js';

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
          AGENT_API_TOKEN: process.env.AGENT_API_TOKEN ?? '',
          AGENT_API_URL: `http://localhost:${process.env.AGENT_PORT ?? 3001}`,
        },
      },
    },
  };
  await writeFile(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));
  log.info({ mcpConfigPath, claudeBin }, 'MCP config written');

  // Initialize skill registry
  const skillCrypto = new SkillCryptoStore();

  // Initialize OAuth provider store early (needed by ConnectionManager)
  const oauthProviderStore = new OAuthProviderStore(skillCrypto);
  await oauthProviderStore.load();

  // Initialize connection manager for OAuth token refresh
  const connectionManager = new ConnectionManager(skillCrypto, oauthProviderStore);

  const skillRegistry = new SkillRegistry(skillCrypto, connectionManager);
  await skillRegistry.load();
  log.info({ skills: skillRegistry.list().length }, 'Skill registry loaded');

  // Initialize channel registry
  const channelRegistry = new ChannelRegistry(skillCrypto, '/data', connectionManager);
  await channelRegistry.load();
  log.info({ channels: channelRegistry.list().length }, 'Channel registry loaded');

  // Initial token refresh sweep for all OAuth entities
  const allEntities = [
    ...skillRegistry.list()
      .filter((s) => s.config?.oauth)
      .map((s) => ({ dir: s.filePath, oauth: s.config!.oauth })),
    ...channelRegistry.list()
      .filter((ch) => ch.config?.oauth)
      .map((ch) => ({ dir: ch.filePath, oauth: ch.config!.oauth })),
  ];
  if (allEntities.length > 0) {
    log.info({ count: allEntities.length }, 'Running initial OAuth token refresh sweep');
    connectionManager.refreshAll(allEntities).catch((err) => {
      log.error({ err }, 'Initial token refresh sweep failed');
    });
  }

  // Background refresh every 30 minutes
  setInterval(() => {
    const entities = [
      ...skillRegistry.list()
        .filter((s) => s.config?.oauth)
        .map((s) => ({ dir: s.filePath, oauth: s.config!.oauth })),
      ...channelRegistry.list()
        .filter((ch) => ch.config?.oauth)
        .map((ch) => ({ dir: ch.filePath, oauth: ch.config!.oauth })),
    ];
    connectionManager.refreshAll(entities).catch((err) => {
      log.error({ err }, 'Background token refresh sweep failed');
    });
  }, 30 * 60 * 1000);

  // Auto-start enabled channels
  for (const channel of channelRegistry.list()) {
    if (channel.status === 'enabled') {
      try {
        await channelRegistry.startChannel(channel.dirName);
        log.info({ channel: channel.dirName }, 'Channel started');
      } catch (err) {
        log.error({ channel: channel.dirName, err }, 'Failed to start channel');
      }
    }
  }

  // Initialize OAuth handler
  const oauthRedirectDomain = process.env.OAUTH_REDIRECT_DOMAIN;
  const oauthRedirectUri = oauthRedirectDomain
    ? `${oauthRedirectDomain}/oauth/callback`
    : undefined; // Will default to http://localhost:3000/oauth/callback
  const oauthHandler = new OAuthHandler({
    providerStore: oauthProviderStore,
    skillRegistry,
    channelRegistry,
    redirectUri: oauthRedirectUri,
  });
  log.info({ redirectUri: oauthRedirectUri || 'http://localhost:3000/oauth/callback' }, 'OAuth handler initialized');

  // Initialize channel pairing service
  const pairingService = new ChannelPairingService();
  await pairingService.load();
  log.info('Channel pairing service loaded');

  // Load model provider configuration and create provider
  const modelConfigPath = '/data/model-config.json';
  const providerConfig = await ProviderFactory.loadConfig(modelConfigPath);
  const provider = ProviderFactory.create(providerConfig, claudeBin, mcpConfigPath);
  log.info({ provider: provider.getName() }, 'Model provider initialized');

  // Initialize conversation database
  const dbPath = process.env.DB_PATH ?? '/data/conversations.db';
  const database = new ConversationDatabase(dbPath);

  // Initialize agent core
  const agent = new AgentCore({
    retriever,
    extractor,
    memory,
    embeddings,
    provider,
    mcpConfigPath,
    skillRegistry,
    database,
  });

  // Shared output dispatcher — sends task/job results to channels
  const dispatchOutput = async (channel: { type: string; id: string }, text: string): Promise<void> => {
    try {
      // Normalize: strip 'channel:' prefix so registry lookup works (handlers keyed by dirName)
      const channelName = channel.type.replace(/^channel:/, '');
      await channelRegistry.sendMessage(channelName, channel.id, text);
    } catch {
      log.info({ channel, textLen: text.length }, 'Task/job output (channel delivery failed or not configured)');
    }
  };

  // Initialize background job manager
  const jobManager = new BackgroundJobManager({
    agent,
    dispatchOutput,
    storagePath: '/data/jobs.json',
    database,
  });
  await jobManager.start();
  log.info('Background job manager started');

  // Wire job manager into agent core (late injection to avoid circular deps)
  agent.setJobManager(jobManager);

  // Initialize task scheduler
  const scheduler = new TaskScheduler({
    agent,
    jobManager,
    dispatchOutput,
    storagePath: '/data/tasks.json',
  });
  await scheduler.start();
  log.info('Task scheduler started');

  // Start internal API server
  const api = createApiServer({ agent, memory, retriever, scheduler, jobManager, skillRegistry, oauthProviderStore, oauthHandler, database, channelRegistry, pairingService, connectionManager });
  const port = Number(process.env.AGENT_PORT ?? 3001);

  const { serve } = await import('@hono/node-server');
  serve({ fetch: api.fetch, port }, () => {
    log.info(`API server listening on :${port}`);
  });

  log.info('Jonas agent ready');

  // Graceful shutdown
  const shutdown = async () => {
    log.info('Shutting down...');

    // Stop all running channels
    for (const channel of channelRegistry.list()) {
      if (channel.state === 'running') {
        await channelRegistry.stopChannel(channel.dirName).catch(() => {});
      }
    }

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
