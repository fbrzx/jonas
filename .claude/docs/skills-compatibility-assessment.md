# Jonas Skills / Agent Skills Compatibility Assessment

## Date: 2026-02-25

---

## 1. Jonas Skill Format (Current)

### Directory Structure
```
/data/skills/<skill-dir-name>/
  skill.md              # Required — YAML frontmatter + markdown body
  config.json           # Optional — declares requiredSecrets, pythonDependencies, oauth flows, requiredChannels
  tools/server.py       # Optional — Python FastMCP stdio server (MCP tool server)
  requirements.txt      # Optional — pip dependencies for tools/server.py
  vault.enc / vault.json # Auto-generated — encrypted per-skill key-value store
```

### skill.md Frontmatter Fields
```yaml
---
name: My Skill            # Display name (free-form, can contain spaces/caps)
description: What it does  # Free-form description
version: 1.0.0            # Semver string
author: fabfab             # Author name
---
Markdown body: instructions injected into agent system prompt when skill is enabled.
```

### config.json Schema (SkillConfig)
```typescript
interface SkillConfig {
  requiredSecrets?: string[];
  pythonDependencies?: string[];
  oauth?: Record<string, OAuthFlowConfig>;  // key = secret name
  requiredChannels?: string[];
}
```

### Tool Execution Model
- Skill tools are Python FastMCP servers (`tools/server.py`) using `@modelcontextprotocol/sdk`
- Launched as child processes with `python3 tools/server.py` over stdio
- Per-skill encrypted vault values injected as environment variables
- MCP server entries are written into the agent's MCP config as `skill-<dir-name>`
- Tools are real MCP tools exposed to the Claude CLI subprocess

### Prompt Integration
- The markdown body of `skill.md` (after frontmatter) is appended to the agent system prompt under "Active Skills" when the skill is enabled
- Progressive: skill prompts only included for enabled skills

### Lifecycle
- Skills live at `/data/skills/` (Docker volume mount from `.volumes/agent-data/skills/`)
- Enable/disable tracked in `/data/skills.json`
- Import/export via ZIP (vault files excluded for security)
- Hot-reload on source update
- CRUD via agent tools (skill_create, skill_list, skill_enable, skill_disable, skill_set_value)

---

## 2. Agent Skills Format (Anthropic Open Standard)

### Directory Structure
```
<skill-name>/
  SKILL.md              # Required — YAML frontmatter + markdown body
  scripts/              # Optional — executable scripts (Python, Bash, JS)
  references/           # Optional — additional docs loaded on demand
  assets/               # Optional — static resources (templates, images, data)
```

### SKILL.md Frontmatter Fields
```yaml
---
name: skill-name          # Required. 1-64 chars, lowercase a-z + hyphens only, must match dir name
description: ...          # Required. 1-1024 chars. What it does + when to use it
license: Apache-2.0       # Optional
compatibility: ...        # Optional. 1-500 chars. Environment requirements
metadata:                 # Optional. Arbitrary string->string map
  author: example-org
  version: "1.0"
allowed-tools: Bash Read  # Optional. Space-delimited pre-approved tool names (experimental)
---
Markdown body: instructions loaded when skill is activated.
```

### Tool Execution Model
- Agent Skills do NOT define their own MCP tools
- Skills provide instructions and scripts that agents execute using existing tools (Bash, Read, Write, etc.)
- Scripts in `scripts/` are run by the agent via its Bash tool within its sandbox
- Skills orchestrate existing tools rather than creating new tool endpoints
- The `allowed-tools` field (experimental) declares which host tools the skill may use

### Prompt Integration
- Progressive disclosure: `name` + `description` (~100 tokens) loaded at startup for all skills
- Full SKILL.md body (<5000 tokens recommended) loaded when skill is activated
- `references/` and `scripts/` loaded on demand
- Activation is automatic based on description matching (in Claude Code)

### Lifecycle
- Skills stored in `~/.claude/skills/` (personal) or `.claude/skills/` (project-level)
- Distributed via plugins (`/plugin marketplace`)
- No built-in enable/disable state, secret management, or OAuth
- No import/export mechanism (just copy the directory)
- Validated with `skills-ref validate ./my-skill`

### Adoption
- Open standard at agentskills.io
- Supported by Claude Code, Cursor, GitHub Copilot, Gemini CLI, VS Code, OpenAI Codex, JetBrains Junie, and 25+ other agents

---

## 3. Compatibility Gap Analysis

### A. Structural Differences

| Aspect | Jonas Skills | Agent Skills | Gap Severity |
|--------|-------------|--------------|-------------|
| Required file | `skill.md` | `SKILL.md` | Trivial (filename case) |
| Name format | Free-form with spaces/caps | Lowercase a-z, hyphens only, 1-64 chars | Moderate |
| Name must match dir | No (meta.name != dirName allowed) | Yes (must match parent dir) | Moderate |
| Description length | Unlimited | Max 1024 chars | Low |
| Version/author | Top-level frontmatter fields | Nested under `metadata` map | Low |
| License field | Not supported | Optional | None (additive) |
| Compatibility field | Not supported | Optional | None (additive) |
| allowed-tools | Not supported | Optional (experimental) | None (additive) |

### B. Tool Provisioning (Critical Difference)

This is the fundamental architectural gap:

- **Jonas**: Skills can define their own MCP tool servers (`tools/server.py`) that expose new tools to the agent. This is the primary way Jonas skills add capabilities. The tools are real MCP endpoints, launched as child processes, and injected into the Claude CLI's MCP config.

- **Agent Skills**: Skills explicitly cannot define new tools. They provide instructions and scripts that orchestrate the agent's existing tools (Bash, Read, Write). Scripts in `scripts/` are meant to be executed by the agent via its Bash tool.

**Impact**: A Jonas skill with `tools/server.py` (e.g., Gmail, GitHub, football-scores) cannot be represented as a standard Agent Skill without either (a) converting the MCP tool server into a standalone MCP server configured separately, or (b) rewriting the tool as a script that the agent runs via Bash. Option (b) loses the structured tool interface that MCP provides.

### C. Secret Management

| Aspect | Jonas Skills | Agent Skills |
|--------|-------------|--------------|
| Per-skill secrets | Yes (vault.enc with AES-256-GCM) | No built-in mechanism |
| OAuth integration | Yes (config.json oauth flows) | Not addressed |
| Env var injection | Yes (into MCP server process) | Not addressed |

**Impact**: Agent Skills have no specification for secrets or credentials. Any Jonas skill that relies on `skill_set_value` or OAuth connections has no portable equivalent. Each consuming agent platform would need its own secrets mechanism.

### D. Configuration

| Aspect | Jonas Skills | Agent Skills |
|--------|-------------|--------------|
| config.json | Yes (requiredSecrets, deps, oauth, channels) | Not supported |
| Python dependencies | requirements.txt + auto-install | Not addressed (agent-dependent) |
| Required channels | Yes | Not applicable |

### E. Lifecycle and State

| Aspect | Jonas Skills | Agent Skills |
|--------|-------------|--------------|
| Enable/disable | Yes (persisted state) | Not specified |
| Import/export | ZIP with security filtering | Not specified (copy dir) |
| Hot reload | Yes | Agent-dependent |
| CRUD via agent tools | Yes (skill_create etc.) | Not specified |

### F. Prompt Body Compatibility

The markdown body in both formats serves the same purpose: instructions injected into the agent's context when the skill is active. **This is the most compatible aspect.** The body content is free-form markdown in both systems and semantically identical.

---

## 4. Migration/Bridge Strategy Options

### Option A: Dual-Format Export (Recommended)

Maintain Jonas's richer native format while adding the ability to export skills as Agent Skills-compatible packages.

**How it works:**
1. Add an `exportAsAgentSkill(name)` method to `SkillRegistry`
2. Generate a `SKILL.md` file from the Jonas `skill.md`:
   - Lowercase the `name`, replace spaces/special chars with hyphens, truncate to 64 chars
   - Truncate `description` to 1024 chars
   - Move `version` and `author` into a `metadata` map
   - Keep the markdown body as-is
3. If the skill has `tools/server.py`, include it in `scripts/` with a wrapper note in the SKILL.md body explaining it is an MCP server requiring separate configuration
4. Copy `requirements.txt` and any other files into appropriate subdirectories
5. Exclude vault files and config.json (secrets are not portable)

**Pros:** No changes to Jonas internals. Skills that are instruction-only export cleanly. Skills with MCP tools export with documentation about how to configure the MCP server separately.

**Cons:** MCP-tool-based skills are not truly plug-and-play in Agent Skills consumers. The consumer needs to configure the MCP server independently.

### Option B: Agent Skills Import

Add the ability for Jonas to import standard Agent Skills.

**How it works:**
1. Accept a directory with `SKILL.md` (Agent Skills format)
2. Convert frontmatter: rename `SKILL.md` to `skill.md`, map `metadata.author` and `metadata.version` to top-level fields
3. Import `scripts/` content as utility scripts (not as MCP servers)
4. Import `references/` and `assets/` as-is into the skill directory
5. The markdown body becomes the skill prompt, just as with native skills

**Pros:** Jonas can consume the growing ecosystem of Agent Skills. Low implementation effort for instruction-only skills.

**Cons:** Scripts in Agent Skills are designed to be run by the agent via Bash, which may not map cleanly to Jonas's model (Jonas uses Claude CLI subprocess, not direct Bash execution). Agent Skills that rely on `allowed-tools` like Bash, Read, Write may not work if Jonas does not expose those same tools.

### Option C: Skill Adapter Layer

Create an abstraction layer that normalizes both formats into a common internal representation.

**How it works:**
1. Define a `UnifiedSkill` interface that is a superset of both formats
2. Write loaders for both `skill.md` (Jonas) and `SKILL.md` (Agent Skills)
3. The registry operates on `UnifiedSkill` objects regardless of source format
4. Tool provisioning remains Jonas-specific (MCP servers), but prompt content is format-agnostic

**Pros:** Clean architecture. Supports both formats natively. Future-proof for spec changes.

**Cons:** More engineering effort. Adds complexity to the skill loader. May over-abstract for the current scale.

### Option D: MCP Server Extraction

For Jonas skills with tools, extract the MCP server into a standalone package that can be used alongside Agent Skills.

**How it works:**
1. When exporting a Jonas skill that has `tools/server.py`, produce TWO artifacts:
   - An Agent Skill (SKILL.md + scripts/ + references/) with instructions only
   - A standalone MCP server package (server.py + requirements.txt) with setup instructions
2. The Agent Skill's body references the companion MCP server

**Pros:** Clean separation of concerns. Aligns with how Agent Skills and MCP are meant to complement each other. The MCP server can be shared independently.

**Cons:** Two artifacts to manage. Users of the Agent Skill must also set up the MCP server.

---

## 5. Recommendation

### Short Term: Option A (Dual-Format Export) + Option B (Agent Skills Import)

1. **Export**: Add `exportAsAgentSkill()` to produce Agent Skills-compatible packages from Jonas skills. For instruction-only skills (no tools/server.py), this is a clean 1:1 mapping. For tool-bearing skills, include the MCP server in `scripts/` with documentation.

2. **Import**: Add `importAgentSkill()` that accepts SKILL.md-format directories. Convert frontmatter fields and load the markdown body as the skill prompt. Log a warning if the skill contains scripts that reference tools Jonas may not expose directly.

3. **Naming convention**: When importing Agent Skills, use the `name` field as the `dirName` directly (it already meets the lowercase-hyphen requirement). When exporting, derive a valid Agent Skills name from the Jonas skill name.

### Medium Term: Option D (MCP Server Extraction)

For skills with tool servers, formalize the pattern of "Agent Skill (instructions) + companion MCP server (tools)" as a first-class export format. This aligns with the intended design of the Agent Skills ecosystem where skills provide expertise and MCP provides tooling.

### What NOT to Do

- Do not try to make Jonas skills 100% Agent Skills-compatible at the native level. The tool provisioning model is fundamentally different and Jonas's richer model (secrets, OAuth, MCP tools) is a genuine advantage.
- Do not abandon `config.json` or the vault system. These are features the Agent Skills spec deliberately does not address, leaving it to platform implementations.
- Do not rename `skill.md` to `SKILL.md` in Jonas's native format. This would break existing skills and the convention is already established.

---

## 6. Implementation Estimate

| Task | Effort | Priority |
|------|--------|----------|
| `exportAsAgentSkill()` method | 1-2 days | High |
| `importAgentSkill()` method | 1-2 days | High |
| Agent Skills name validation/normalization utility | 0.5 day | High |
| Dashboard UI for export/import format selection | 1 day | Medium |
| MCP server extraction packaging | 1-2 days | Medium |
| Documentation and examples | 0.5 day | Medium |
| `skills-ref validate` integration | 0.5 day | Low |

**Total: ~5-8 engineering days**

---

## 7. Key Files Referenced

- `/Users/fabfab/Projects/jonas/services/agent/src/skills/registry.ts` — Skill registry with load, create, import/export, MCP server generation
- `/Users/fabfab/Projects/jonas/services/agent/src/skills/storage.ts` — Skill state persistence
- `/Users/fabfab/Projects/jonas/services/agent/src/skills/crypto-store.ts` — Per-skill encrypted vault
- `/Users/fabfab/Projects/jonas/packages/shared/src/types/skill.ts` — Skill, SkillMetadata, SkillConfig types
- `/Users/fabfab/Projects/jonas/services/agent/src/agent/prompt.ts` — System prompt assembly with skill prompts
- `/Users/fabfab/Projects/jonas/services/agent/src/agent/core.ts` — MCP config sync for skill tool servers
- `/Users/fabfab/Projects/jonas/.volumes/agent-data/skills/gmail/` — Example skill with OAuth + MCP tools
