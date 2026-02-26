import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AgentRegistry } from '../registry.js';
import { ConversationDatabase } from '../../storage/database.js';
import type { MemoryRetriever } from '../../memory/retriever.js';
import type { MemoryExtractor } from '../../memory/extractor.js';

function makeDb() {
  return new ConversationDatabase(':memory:');
}

// Minimal shared deps — no network calls needed for registry construction tests
function makeShared(db: ConversationDatabase) {
  return {
    retriever: { retrieve: vi.fn(async () => []) } as unknown as MemoryRetriever,
    extractor: { extract: vi.fn(async () => {}) } as unknown as MemoryExtractor,
    database: db,
  };
}

function makeRegistry(db: ConversationDatabase) {
  return new AgentRegistry(db, makeShared(db), '/usr/bin/claude', '/tmp/mcp.json');
}

// Pre-seed one or more agents in the DB so registry.load() doesn't try to read /data/model-config.json
function seedAgent(
  db: ConversationDatabase,
  opts: { id?: string; name?: string; isDefault?: boolean; enabled?: boolean; provider?: 'claude' | 'ollama' } = {},
) {
  return db.createAgent({
    id: opts.id ?? 'agent_1',
    name: opts.name ?? 'default',
    description: null,
    provider: opts.provider ?? 'claude',
    claudeModel: 'claude-sonnet-4-6',
    ollamaBaseUrl: opts.provider === 'ollama' ? 'http://localhost:11434' : null,
    ollamaModel: opts.provider === 'ollama' ? 'llama3.2' : null,
    systemPromptOverride: null,
    isDefault: opts.isDefault ?? true,
    enabled: opts.enabled ?? true,
  });
}

describe('AgentRegistry', () => {
  let db: ConversationDatabase;
  let registry: AgentRegistry;

  beforeEach(() => {
    db = makeDb();
    registry = makeRegistry(db);
  });

  describe('load', () => {
    it('loads enabled agents from database', async () => {
      seedAgent(db, { id: 'agent_1', name: 'default', isDefault: true });
      await registry.load();
      expect(registry.size).toBe(1);
    });

    it('does not load disabled agents into active entries', async () => {
      seedAgent(db, { id: 'agent_1', name: 'default', isDefault: true, enabled: false });
      await registry.load();
      expect(registry.size).toBe(0);
    });

    it('loads multiple agents', async () => {
      seedAgent(db, { id: 'agent_1', name: 'default', isDefault: true });
      seedAgent(db, { id: 'agent_2', name: 'secondary', isDefault: false });
      await registry.load();
      expect(registry.size).toBe(2);
    });

    it('sets default agent from DB isDefault flag', async () => {
      seedAgent(db, { id: 'agent_1', name: 'default', isDefault: true });
      seedAgent(db, { id: 'agent_2', name: 'other', isDefault: false });
      await registry.load();
      const defaultCore = registry.getDefault();
      expect(defaultCore).toBeDefined();
    });

    it('falls back to first agent if none marked default', async () => {
      // Bypass the setDefault logic by directly inserting without is_default=1
      db.createAgent({
        id: 'agent_x',
        name: 'only',
        description: null,
        provider: 'claude',
        claudeModel: 'claude-sonnet-4-6',
        ollamaBaseUrl: null,
        ollamaModel: null,
        systemPromptOverride: null,
        isDefault: false,
        enabled: true,
      });
      await registry.load();
      // Should not throw — falls back to first entry
      expect(() => registry.getDefault()).not.toThrow();
    });
  });

  describe('getDefault', () => {
    it('throws when no agents are configured', async () => {
      // Load with empty DB triggers seeding, which reads /data/model-config.json (may not exist)
      // Instead, test the throw case by loading with a disabled-only DB
      seedAgent(db, { id: 'agent_1', name: 'default', isDefault: true, enabled: false });
      await registry.load();
      expect(() => registry.getDefault()).toThrow('No default agent configured');
    });
  });

  describe('resolve', () => {
    beforeEach(async () => {
      seedAgent(db, { id: 'agent_1', name: 'default', isDefault: true });
      seedAgent(db, { id: 'agent_2', name: 'secondary', isDefault: false });
      await registry.load();
    });

    it('returns the requested agent when agentId exists', () => {
      const core = registry.resolve('agent_2');
      expect(core).toBe(registry.getById('agent_2'));
    });

    it('falls back to default when agentId is not found', () => {
      const core = registry.resolve('nonexistent_id');
      expect(core).toBe(registry.getDefault());
    });

    it('returns default when agentId is null', () => {
      const core = registry.resolve(null);
      expect(core).toBe(registry.getDefault());
    });

    it('returns default when agentId is undefined', () => {
      const core = registry.resolve(undefined);
      expect(core).toBe(registry.getDefault());
    });
  });

  describe('getById', () => {
    beforeEach(async () => {
      seedAgent(db, { id: 'agent_1', name: 'default', isDefault: true });
      await registry.load();
    });

    it('returns the agent core for a known id', () => {
      expect(registry.getById('agent_1')).toBeDefined();
    });

    it('returns undefined for an unknown id', () => {
      expect(registry.getById('nope')).toBeUndefined();
    });
  });

  describe('list', () => {
    beforeEach(async () => {
      seedAgent(db, { id: 'agent_1', name: 'default', isDefault: true });
      seedAgent(db, { id: 'agent_2', name: 'secondary', isDefault: false });
      await registry.load();
    });

    it('returns all DB agents with runtime metadata', () => {
      const items = registry.list();
      expect(items).toHaveLength(2);
    });

    it('marks active agents correctly', () => {
      const items = registry.list();
      expect(items.every((i) => i.active)).toBe(true);
    });

    it('includes providerName for active agents', () => {
      const items = registry.list();
      for (const item of items) {
        expect(item.providerName).toBeTruthy();
      }
    });
  });

  describe('addAgent', () => {
    beforeEach(async () => {
      seedAgent(db, { id: 'agent_1', name: 'default', isDefault: true });
      await registry.load();
    });

    it('persists agent to DB and activates it', async () => {
      const row = await registry.addAgent({
        name: 'coding',
        provider: 'claude',
        claudeModel: 'claude-opus-4-6',
      });
      expect(row.id).toBeTruthy();
      expect(registry.getById(row.id)).toBeDefined();
      expect(db.getAgent(row.id)).not.toBeNull();
    });

    it('setting new agent as default clears previous default', async () => {
      await registry.addAgent({
        name: 'new-default',
        provider: 'claude',
        claudeModel: 'claude-haiku-4-5-20251001',
        isDefault: true,
      });
      // Original default in DB should now be false
      expect(db.getAgent('agent_1')!.isDefault).toBe(false);
    });

    it('does not activate disabled agent', async () => {
      const row = await registry.addAgent({
        name: 'disabled-agent',
        provider: 'claude',
        claudeModel: 'claude-sonnet-4-6',
        enabled: false,
      });
      expect(registry.getById(row.id)).toBeUndefined();
    });
  });

  describe('updateAgent', () => {
    beforeEach(async () => {
      seedAgent(db, { id: 'agent_1', name: 'default', isDefault: true });
      await registry.load();
    });

    it('updates DB record', async () => {
      await registry.updateAgent('agent_1', { claudeModel: 'claude-opus-4-6' });
      expect(db.getAgent('agent_1')!.claudeModel).toBe('claude-opus-4-6');
    });

    it('recreates AgentCore when provider changes', async () => {
      const coreBefore = registry.getById('agent_1');
      await registry.updateAgent('agent_1', { provider: 'ollama', ollamaBaseUrl: 'http://localhost:11434', ollamaModel: 'llama3.2' });
      const coreAfter = registry.getById('agent_1');
      // Core should be a different instance (recreated)
      expect(coreAfter).not.toBe(coreBefore);
    });

    it('deactivates agent when enabled set to false', async () => {
      await registry.updateAgent('agent_1', { enabled: false });
      expect(registry.getById('agent_1')).toBeUndefined();
    });
  });

  describe('deleteAgent', () => {
    beforeEach(async () => {
      seedAgent(db, { id: 'agent_1', name: 'default', isDefault: true });
      seedAgent(db, { id: 'agent_2', name: 'secondary', isDefault: false });
      await registry.load();
    });

    it('removes agent from DB and registry', async () => {
      await registry.deleteAgent('agent_2');
      expect(db.getAgent('agent_2')).toBeNull();
      expect(registry.getById('agent_2')).toBeUndefined();
      expect(registry.size).toBe(1);
    });
  });

  describe('setDefault', () => {
    beforeEach(async () => {
      seedAgent(db, { id: 'agent_1', name: 'default', isDefault: true });
      seedAgent(db, { id: 'agent_2', name: 'secondary', isDefault: false });
      await registry.load();
    });

    it('changes the default agent in DB', async () => {
      await registry.setDefault('agent_2');
      expect(db.getAgent('agent_1')!.isDefault).toBe(false);
      expect(db.getAgent('agent_2')!.isDefault).toBe(true);
    });

    it('resolve with no agentId returns the new default', async () => {
      await registry.setDefault('agent_2');
      expect(registry.resolve()).toBe(registry.getById('agent_2'));
    });

    it('throws for unknown agent id', async () => {
      await expect(registry.setDefault('ghost')).rejects.toThrow('Agent not found: ghost');
    });
  });
});
