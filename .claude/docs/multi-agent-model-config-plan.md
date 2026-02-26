# Multi-Agent / Multi-Model Configuration Plan

## Overview

Extend Jonas to support multiple named agents, each configured with its own model provider (Claude model, Ollama model, or future providers). Channels and tasks can be routed to specific agents, with a default fallback.

---

## Current State

- **Single agent**: One `AgentCore` instance initialized at startup with one `ModelProvider`
- **ProviderFactory**: Reads `/data/model-config.json` — single `{ provider, claude, ollama }` config
- **Provider abstraction**: `ModelProvider` interface already exists (`ClaudeProvider`, `OllamaProvider`)
- **Dashboard `/model`**: UI to edit the single model config; agent restart required to apply
- **Channels**: Dispatch all messages to the single `AgentCore`

---

## Goal State

- **Multiple agents**: Named `AgentConfig` records in SQLite; each has its own provider + model
- **AgentRegistry**: Manages agent lifecycle — creates/starts/stops/deletes agent instances
- **Channel routing**: Each channel can be assigned a specific agent (default: the "default" agent)
- **Task routing**: Scheduled tasks can target a specific agent
- **Dashboard `/agents`**: Full CRUD UI — create, edit, delete, assign default, assign to channels
- **Hot-reload**: Switch active model without restarting the container (where possible)

---

## Architecture Decisions

### Shared vs. Per-Agent Resources

| Resource | Shared | Per-Agent |
|---|---|---|
| Memory (Qdrant) | ✅ | — |
| Skills | ✅ | — |
| Database (SQLite) | ✅ | — |
| OAuth store | ✅ | — |
| Channel infrastructure | ✅ | — |
| `ModelProvider` | — | ✅ |
| System prompt (optional override) | — | ✅ |
| Session/conversation state | — | ✅ (namespaced by agent_id) |

### Multiple AgentCore Instances

Each named agent gets its own `AgentCore` instance sharing infrastructure (memory, skills, db) but with its own `ModelProvider`. This keeps the existing `AgentCore` API unchanged and allows per-agent features later (custom tools, custom system prompt).

### Hot-Reload Strategy

- **Ollama**: No restart needed — provider is stateless HTTP
- **Claude CLI**: Each request spawns a subprocess — model can change per-request
- **On config change**: Update the provider in-place; no container restart needed for model switches

---

## Data Model

### New: `agents` Table

```sql
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,           -- e.g. "agent_01J..."
  name TEXT NOT NULL UNIQUE,     -- human-readable name, e.g. "coding-assistant"
  description TEXT,              -- optional description
  provider TEXT NOT NULL DEFAULT 'claude',  -- 'claude' | 'ollama'
  claude_model TEXT,             -- e.g. "claude-opus-4-6"
  ollama_base_url TEXT,          -- e.g. "http://localhost:11434"
  ollama_model TEXT,             -- e.g. "qwen2.5-coder:latest"
  system_prompt_override TEXT,   -- optional extra system prompt appended
  is_default INTEGER NOT NULL DEFAULT 0,  -- only one can be default
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_name ON agents(name);
CREATE INDEX IF NOT EXISTS idx_agents_default ON agents(is_default);
```

### Modified: `conversations` Table

Add `agent_id` column to track which agent handled each conversation:

```sql
ALTER TABLE conversations ADD COLUMN agent_id TEXT;
CREATE INDEX IF NOT EXISTS idx_conversations_agent_id ON conversations(agent_id);
```

### Migration Strategy

- `agents` table is new — no migration needed
- `conversations.agent_id` is nullable — `ALTER TABLE` is safe on SQLite
- On startup: if no agents exist, seed one default agent from the existing `/data/model-config.json`

---

## Implementation Plan

### Phase 1: Storage Layer (database.ts)

**File**: `services/agent/src/storage/database.ts`

Add `AgentRow` interface and CRUD methods:

```typescript
export interface AgentRow {
  id: string;
  name: string;
  description?: string;
  provider: 'claude' | 'ollama';
  claudeModel?: string;
  ollamaBaseUrl?: string;
  ollamaModel?: string;
  systemPromptOverride?: string;
  isDefault: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}
```

Methods to add:
- `createAgent(row: Omit<AgentRow, 'createdAt' | 'updatedAt'>): AgentRow`
- `getAgent(id: string): AgentRow | null`
- `getAgentByName(name: string): AgentRow | null`
- `getDefaultAgent(): AgentRow | null`
- `listAgents(): AgentRow[]`
- `updateAgent(id: string, updates: Partial<AgentRow>): AgentRow`
- `deleteAgent(id: string): void`
- `setDefaultAgent(id: string): void`

---

### Phase 2: AgentRegistry Service

**New file**: `services/agent/src/agent/registry.ts`

```typescript
export class AgentRegistry {
  private instances = new Map<string, AgentCore>();

  constructor(
    private database: ConversationDatabase,
    private sharedDeps: SharedAgentDeps,  // memory, skills, etc.
    private claudeBin: string,
    private mcpConfigPath: string,
  ) {}

  async load(): Promise<void>   // Load all enabled agents from DB, create AgentCore instances
  async createAgent(config: AgentRow): Promise<AgentCore>  // Instantiate from config

  getAgent(id: string): AgentCore | undefined
  getDefaultAgent(): AgentCore | undefined
  getAgentForChannel(channelName: string): AgentCore  // Falls back to default

  async addAgent(config: NewAgentConfig): Promise<AgentRow>   // Persist + instantiate
  async updateAgent(id: string, updates: Partial<AgentRow>): Promise<void>  // Update provider in-place
  async deleteAgent(id: string): Promise<void>
  async setDefault(id: string): Promise<void>

  list(): Array<{ row: AgentRow; active: boolean; providerName: string }>
}
```

**Shared deps** (extracted interface):
```typescript
export interface SharedAgentDeps {
  retriever: MemoryRetriever;
  extractor: MemoryExtractor;
  memory?: MemoryClient;
  embeddings?: EmbeddingClient;
  skillRegistry?: SkillRegistry;
  database: ConversationDatabase;
  jobManager?: BackgroundJobManager;
}
```

---

### Phase 3: Channel-to-Agent Assignment

**File**: `services/agent/src/channels/types.ts`

Add optional `agentId` to channel config:

```typescript
export interface ChannelConfig {
  // ... existing fields
  agentId?: string;  // which agent handles messages for this channel
}
```

**File**: `services/agent/src/channels/registry.ts`

Update `sendMessage` / dispatch to look up the agent from `AgentRegistry` instead of holding a reference to a single `AgentCore`.

---

### Phase 4: Refactor Startup (index.ts)

Replace single agent + provider creation with:

```typescript
// 1. Initialize shared deps (memory, skills, db) — unchanged

// 2. Create AgentRegistry (replaces single provider + AgentCore)
const agentRegistry = new AgentRegistry(database, sharedDeps, claudeBin, mcpConfigPath);
await agentRegistry.load();  // loads from DB; seeds default from model-config.json if empty

// 3. Pass agentRegistry everywhere that previously got agent
const api = createApiServer({ agentRegistry, ...otherDeps });

// 4. Channels dispatch via agentRegistry.getAgentForChannel(channelName)
```

---

### Phase 5: API Endpoints

**File**: `services/agent/src/api/server.ts`

New agent endpoints:

```
GET    /api/agents                     List all agents with runtime status
POST   /api/agents                     Create a new agent
GET    /api/agents/:id                 Get agent config
PUT    /api/agents/:id                 Update agent config (applies immediately)
DELETE /api/agents/:id                 Delete agent (must not be default)
POST   /api/agents/:id/set-default     Set as default agent
GET    /api/agents/:id/status          Runtime status (uptime, conversations, provider)
```

**Request/response shape**:
```typescript
// POST /api/agents
{
  name: string;           // "coding-assistant"
  description?: string;
  provider: 'claude' | 'ollama';
  claudeModel?: string;   // if provider === 'claude'
  ollamaBaseUrl?: string; // if provider === 'ollama'
  ollamaModel?: string;   // if provider === 'ollama'
  systemPromptOverride?: string;
  isDefault?: boolean;
}

// GET /api/agents response
{
  agents: Array<{
    id: string;
    name: string;
    description?: string;
    provider: string;
    model: string;         // resolved model name
    isDefault: boolean;
    enabled: boolean;
    active: boolean;       // runtime: has AgentCore instance
    providerName: string;  // e.g. "claude:claude-opus-4-6"
    uptime?: number;
    activeConversations?: number;
    createdAt: string;
    updatedAt: string;
  }>
}
```

---

### Phase 6: Dashboard UI

**New route**: `apps/dashboard/src/routes/agents.ts`

**Page: `/agents`** — Agent list

```
┌──────────────────────────────────────────────────────────┐
│ Agents                                      [+ New Agent] │
├──────────────────────────────────────────────────────────┤
│ ● default                              [DEFAULT] [Claude] │
│   claude-opus-4-6                                         │
│   "General purpose assistant"                             │
│   3 active conversations                                  │
│   [Edit] [Delete]                                         │
├──────────────────────────────────────────────────────────┤
│ ● coding-assistant                           [Claude]     │
│   claude-sonnet-4-6                                       │
│   "Code generation and debugging"                         │
│   0 active conversations                                  │
│   [Set Default] [Edit] [Delete]                           │
├──────────────────────────────────────────────────────────┤
│ ○ local-model                         [DISABLED] [Ollama] │
│   llama3.2:latest @ http://localhost:11434                │
│   [Enable] [Edit] [Delete]                                │
└──────────────────────────────────────────────────────────┘
```

**Modal: Create/Edit Agent**

```
┌──────────────────────────────────────────────────────────┐
│ Create Agent                                             │
├──────────────────────────────────────────────────────────┤
│ Name:         [coding-assistant          ]               │
│ Description:  [Code generation and debugging]            │
│                                                          │
│ Provider:  ○ Claude (via OAuth)  ○ Ollama (local)       │
│                                                          │
│ Model:    [claude-sonnet-4-6             ]               │
│           Common: [Opus 4.6] [Sonnet 4.6] [Haiku 4.5]  │
│                                                          │
│ System prompt override (optional):                       │
│ [                                        ]               │
│ [                                        ]               │
│                                                          │
│ ☐ Set as default agent                                   │
│                                                          │
│            [Cancel] [Create Agent]                       │
└──────────────────────────────────────────────────────────┘
```

**Channel assignment** (in channels page):
- Add "Agent" dropdown to each channel's settings: `[Default] [coding-assistant] [local-model]`

---

### Phase 7: Channel Assignment UI

**File**: `apps/dashboard/src/routes/channels.ts`

Add agent assignment field to channel detail/edit view. Calls:
- `PUT /api/channels/:name` with `{ agentId: "agent_01J..." }`

---

## File Change Summary

### New Files
```
services/agent/src/agent/registry.ts          AgentRegistry class
apps/dashboard/src/routes/agents.ts           Dashboard agents route
```

### Modified Files
```
services/agent/src/storage/database.ts        Add agents table, AgentRow, CRUD methods
services/agent/src/agent/core.ts              Accept optional agentId for audit/tracking
services/agent/src/agent/providers/factory.ts Add createFromAgentRow() helper
services/agent/src/channels/types.ts          Add agentId to ChannelConfig
services/agent/src/channels/registry.ts       Use AgentRegistry for routing
services/agent/src/api/server.ts              Add /api/agents/* endpoints
services/agent/src/index.ts                   Replace single agent with AgentRegistry
apps/dashboard/src/index.ts                   Mount /agents route
apps/dashboard/src/views/layout.ts            Add "Agents" nav link
apps/dashboard/src/routes/channels.ts         Add agent assignment dropdown
apps/dashboard/src/routes/model.ts            Deprecate (redirect to /agents) or keep for legacy
```

---

## Migration / Seeding

On first startup with the new code:
1. Create `agents` table if not exists
2. If `agents` table is empty, read `/data/model-config.json`
3. Seed one agent named `"default"` from that config, marked as default
4. Continue normally

This means existing deployments transparently migrate to multi-agent with their current model as the default agent.

---

## Implementation Order

### Step 1: Storage Layer
- Add `agents` table schema in `database.ts`
- Add `AgentRow` interface and CRUD methods
- Add `conversations.agent_id` column migration

### Step 2: AgentRegistry
- Create `registry.ts` with `AgentRegistry` class
- Extract `SharedAgentDeps` interface
- Add `createFromAgentRow()` to `ProviderFactory`
- Implement load + seeding logic

### Step 3: Wire into index.ts
- Replace single agent with `AgentRegistry`
- Pass registry to API and channel registry
- Ensure channels fall back to default agent

### Step 4: API endpoints
- Add `/api/agents/*` routes in `server.ts`
- CRUD + set-default + status

### Step 5: Dashboard UI
- Create `agents.ts` route with list + create/edit modal
- Add nav link in `layout.ts`
- Add agent dropdown to channels page
- Deprecate or redirect old `/model` page

### Step 6: Tests
- Unit test `AgentRegistry.load()`, seeding, routing
- Unit test database CRUD methods
- Integration: create agent via API, verify it handles messages

---

## Non-Goals (Out of Scope for Now)

- Per-agent skill subsets (all agents share the same skill registry)
- Agent-to-agent communication / orchestration
- Per-agent memory namespacing (all agents share Qdrant)
- Agent autoscaling / replicas
- Conversation-level agent switching mid-thread

---

## Success Criteria

- [ ] Can create 2+ named agents with different models via dashboard
- [ ] Can assign a specific agent to a channel
- [ ] Messages to that channel are handled by the assigned agent
- [ ] Default agent is used when no channel assignment exists
- [ ] Can update an agent's model without container restart
- [ ] Conversations record which agent handled them
- [ ] All existing functionality works unchanged (backward compatible)
