# Architect Agent Memory

## Jonas Skills System
- Skills live at `/data/skills/<dir>/` with `skill.md` (YAML frontmatter), optional `config.json`, `tools/server.py`, `requirements.txt`
- Tool servers are Python FastMCP over stdio, injected into Claude CLI's MCP config as `skill-<name>`
- Per-skill encrypted vault (AES-256-GCM) for secrets, injected as env vars
- Registry: `services/agent/src/skills/registry.ts`, Types: `packages/shared/src/types/skill.ts`
- Skill prompts appended to system prompt in `services/agent/src/agent/prompt.ts`

## Agent Skills Open Standard (agentskills.io)
- SKILL.md with strict naming: lowercase a-z + hyphens, 1-64 chars, must match dir name
- Skills do NOT define their own tools — they provide instructions + scripts for existing agent tools
- MCP and Skills are complementary: MCP = tool connectivity, Skills = expertise/instructions
- Adopted by 30+ agents: Claude Code, Cursor, GitHub Copilot, Gemini CLI, VS Code, OpenAI Codex, etc.
- Progressive disclosure: metadata at startup, full body on activation, resources on demand

## Compatibility Assessment
- Full assessment written to `.claude/docs/skills-compatibility-assessment.md`
- Key gap: Jonas skills can define MCP tool servers; Agent Skills cannot
- Recommended: dual-format export (Option A) + Agent Skills import (Option B)
- Instruction-only Jonas skills map 1:1; tool-bearing skills need companion MCP server packaging

## Plan Storage Conventions
- Platform enhancement plans for Jonas agent go to `.volumes/agent-data/vault/`
- Core platform enhancement plans go to `.claude/docs/`
- Plans targeting `engineer` agent in Claude Code
