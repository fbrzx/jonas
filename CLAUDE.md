# Jonas — Personal AI Assistant

## Overview
Always-on personal AI assistant running in Docker. Uses Claude Pro (OAuth) via the Agent SDK, stores memories in Qdrant, communicates via Matrix/Element and local Claude Code CLI.

## Tech Stack
- Runtime: Node.js 22
- Package Manager: pnpm (REQUIRED)
- Agent SDK: `@anthropic-ai/claude-agent-sdk` with Pro OAuth
- Chat: Conduit (Matrix) + Element Web
- Vector DB: Qdrant + Voyage AI embeddings
- Dashboard: Hono + HTMX (SSH tunnel only)
- Build: tsup + turbo
- Reverse Proxy: nginx + certbot

## Monorepo Structure
- `apps/dashboard` — Hono + HTMX management UI (SSH tunnel only)
- `services/agent` — Core agent service (Claude SDK, Matrix bot, memory, skills, vault)
- `services/gateway` — WebSocket gateway for Claude Code CLI access
- `packages/shared` — Shared types and utilities
- `packages/acp-bridge` — Local CLI: ACP <> Gateway translator
- `packages/config` — Shared tsconfig
- `deploy/` — nginx, conduit, element-web, qdrant configs
- `data/` — Runtime data (gitignored): vault, custom skills
- `scripts/` — Setup, backup, health check, SSH tunnel helpers

## Commands
- `pnpm install` — Install all dependencies
- `pnpm dev` — Start development (all workspaces)
- `pnpm build` — Build all packages
- `pnpm test` — Run tests
- `pnpm lint` — Check code style
- `docker compose up -d` — Start full stack
- `make dev` — Build + start development
- `make deploy` — Build + deploy to VM

## Environment Variables
See `env.example` for all required variables. Copy to `.env` and fill in values.
Key variables: CLAUDE_CODE_OAUTH_TOKEN, VOYAGE_API_KEY, MATRIX_BOT_PASSWORD, GATEWAY_TOKEN, DOMAIN

## Security
- Dashboard binds 127.0.0.1 only (SSH tunnel required)
- Gateway uses token-based WebSocket auth
- Internal Docker network isolates services
- Agent cannot read .env or secret files via tools
- All tool invocations are audit-logged
