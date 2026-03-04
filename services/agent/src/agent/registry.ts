/**
 * AgentRegistry — manages multiple AgentCore instances, each with its own ModelProvider.
 *
 * All agents share memory, skills, and the database. Each agent has its own
 * ModelProvider (model/provider config) and session state.
 */

import { createLogger, createId, isoNow } from '@jonas/shared/utils';
import { AgentCore, type AgentCoreOptions, type AgentDelegateRegistry } from './core.js';
import { ProviderFactory } from './providers/factory.js';
import type { ConversationDatabase, AgentRow } from '../storage/database.js';
import type { MemoryRetriever } from '../memory/retriever.js';
import type { MemoryExtractor } from '../memory/extractor.js';
import type { MemoryClient } from '../memory/client.js';
import type { EmbeddingClient } from '../memory/embeddings.js';
import type { SkillRegistry } from '../skills/registry.js';
import type { BackgroundJobManager } from '../tasks/job-manager.js';

const log = createLogger('agent-registry');

export interface SharedAgentDeps {
  retriever: MemoryRetriever;
  extractor: MemoryExtractor;
  memory?: MemoryClient;
  embeddings?: EmbeddingClient;
  skillRegistry?: SkillRegistry;
  database: ConversationDatabase;
}

interface AgentEntry {
  row: AgentRow;
  core: AgentCore;
}

export interface AgentListItem {
  row: AgentRow;
  active: boolean;
  providerName: string;
  uptime: number;
  activeConversations: number;
}

export class AgentRegistry {
  private entries = new Map<string, AgentEntry>();
  private defaultId: string | null = null;

  constructor(
    private readonly database: ConversationDatabase,
    private readonly shared: SharedAgentDeps,
    private readonly claudeBin: string,
    private readonly mcpConfigPath: string,
  ) {}

  /** Load all enabled agents from DB; seed from model-config.json if none exist. */
  async load(): Promise<void> {
    const agents = this.database.listAgents();

    if (agents.length === 0) {
      log.info('No agents in database — seeding default from model-config.json');
      await this.seedFromLegacyConfig();
      return;
    }

    for (const row of agents) {
      if (!row.enabled) continue;
      const core = this.createCore(row);
      this.entries.set(row.id, { row, core });
      if (row.isDefault) this.defaultId = row.id;
    }

    // Fallback: no default marked, use first entry
    if (!this.defaultId && this.entries.size > 0) {
      this.defaultId = this.entries.keys().next().value ?? null;
    }

    log.info({ count: this.entries.size, defaultId: this.defaultId }, 'AgentRegistry loaded');
  }

  private createCore(row: AgentRow): AgentCore {
    const provider = ProviderFactory.createForAgent(row, this.claudeBin, this.mcpConfigPath);
    const core = new AgentCore({
      retriever: this.shared.retriever,
      extractor: this.shared.extractor,
      memory: this.shared.memory,
      embeddings: this.shared.embeddings,
      skillRegistry: this.shared.skillRegistry,
      database: this.shared.database,
      provider,
      mcpConfigPath: this.mcpConfigPath,
      systemPromptOverride: row.systemPromptOverride,
      agentId: row.id,
      agentName: row.name,
    } satisfies AgentCoreOptions);
    core.setAgentRegistry(this as unknown as AgentDelegateRegistry);
    return core;
  }

  private async seedFromLegacyConfig(): Promise<void> {
    const config = await ProviderFactory.loadConfig('/data/model-config.json');
    const row = this.database.createAgent({
      id: createId('agent'),
      name: 'default',
      description: 'Default agent (seeded from model-config.json)',
      provider: config.provider,
      claudeModel: config.claude?.model ?? null,
      ollamaBaseUrl: config.ollama?.baseUrl ?? null,
      ollamaModel: config.ollama?.model ?? null,
      systemPromptOverride: null,
      isDefault: true,
      enabled: true,
    });
    const core = this.createCore(row);
    this.entries.set(row.id, { row, core });
    this.defaultId = row.id;
    log.info({ agentId: row.id, provider: row.provider }, 'Seeded default agent');
  }

  /** Return the default AgentCore. Throws if none configured. */
  getDefault(): AgentCore {
    if (!this.defaultId) throw new Error('No default agent configured');
    const entry = this.entries.get(this.defaultId);
    if (!entry) throw new Error(`Default agent ${this.defaultId} not in registry`);
    return entry.core;
  }

  getById(id: string): AgentCore | undefined {
    return this.entries.get(id)?.core;
  }

  getByName(name: string): AgentCore | undefined {
    for (const entry of this.entries.values()) {
      if (entry.row.name === name) return entry.core;
    }
    return undefined;
  }

  /** Resolve agentId → AgentCore, falling back to default. */
  resolve(agentId?: string | null): AgentCore {
    if (agentId) {
      const entry = this.entries.get(agentId);
      if (entry) return entry.core;
      log.warn({ agentId }, 'Requested agent not found, falling back to default');
    }
    return this.getDefault();
  }

  /** List all agents (from DB) with runtime info for those currently active. */
  list(): AgentListItem[] {
    return this.database.listAgents().map((row) => {
      const entry = this.entries.get(row.id);
      return {
        row,
        active: !!entry,
        providerName: entry?.core.getProviderName() ?? '',
        uptime: entry?.core.uptime ?? 0,
        activeConversations: entry?.core.activeConversationCount ?? 0,
      };
    });
  }

  /** Create a new agent, persist to DB, and instantiate its core. */
  async addAgent(params: {
    name: string;
    description?: string | null;
    provider: 'claude' | 'ollama';
    claudeModel?: string | null;
    ollamaBaseUrl?: string | null;
    ollamaModel?: string | null;
    systemPromptOverride?: string | null;
    isDefault?: boolean;
    enabled?: boolean;
  }): Promise<AgentRow> {
    const row = this.database.createAgent({
      id: createId('agent'),
      name: params.name,
      description: params.description ?? null,
      provider: params.provider,
      claudeModel: params.claudeModel ?? null,
      ollamaBaseUrl: params.ollamaBaseUrl ?? null,
      ollamaModel: params.ollamaModel ?? null,
      systemPromptOverride: params.systemPromptOverride ?? null,
      isDefault: params.isDefault ?? false,
      enabled: params.enabled ?? true,
    });

    if (row.enabled) {
      const core = this.createCore(row);
      this.entries.set(row.id, { row, core });
    }

    if (row.isDefault) {
      this.defaultId = row.id;
    }

    log.info({ agentId: row.id, name: row.name }, 'Agent created');
    return row;
  }

  /** Update an agent config. Recreates the AgentCore if model/provider changed. */
  async updateAgent(id: string, updates: Partial<Omit<AgentRow, 'id' | 'createdAt' | 'updatedAt'>>): Promise<AgentRow> {
    const row = this.database.updateAgent(id, updates);
    const existing = this.entries.get(id);

    const providerChanged = updates.provider !== undefined
      || updates.claudeModel !== undefined
      || updates.ollamaBaseUrl !== undefined
      || updates.ollamaModel !== undefined;

    if (row.enabled) {
      if (!existing || providerChanged) {
        // Create or recreate core with new provider (registry injected inside createCore)
        const core = this.createCore(row);
        // Preserve job manager if already set
        const jm = (existing?.core as any)?._jobManager;
        if (jm) core.setJobManager(jm);
        this.entries.set(id, { row, core });
      } else {
        // Just update the row metadata
        existing.row = row;
        // Propagate system prompt override change to the running core
        if (updates.systemPromptOverride !== undefined) {
          existing.core.setSystemPromptOverride(row.systemPromptOverride);
        }
      }
    } else if (existing) {
      // Agent was disabled — remove from active entries
      this.entries.delete(id);
    }

    if (row.isDefault) {
      this.defaultId = id;
    } else if (this.defaultId === id && !row.isDefault) {
      // Was default, no longer — pick first remaining
      this.defaultId = this.entries.keys().next().value ?? null;
    }

    log.info({ agentId: id, updates: Object.keys(updates) }, 'Agent updated');
    return row;
  }

  /** Delete an agent by ID. */
  async deleteAgent(id: string): Promise<void> {
    this.database.deleteAgent(id);
    this.entries.delete(id);
    if (this.defaultId === id) {
      this.defaultId = this.entries.keys().next().value ?? null;
    }
    log.info({ agentId: id }, 'Agent deleted');
  }

  /** Set the default agent. */
  async setDefault(id: string): Promise<void> {
    if (!this.database.getAgent(id)) throw new Error(`Agent not found: ${id}`);
    this.database.setDefaultAgent(id);
    this.defaultId = id;
    // Refresh cached row metadata
    for (const [eid, entry] of this.entries) {
      const refreshed = this.database.getAgent(eid);
      if (refreshed) entry.row = refreshed;
    }
    log.info({ agentId: id }, 'Default agent set');
  }

  /** Forward job manager to all active agent cores (call after job manager init). */
  setJobManager(jm: BackgroundJobManager): void {
    for (const entry of this.entries.values()) {
      entry.core.setJobManager(jm);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}
