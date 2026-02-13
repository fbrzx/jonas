# Jonas — Personal AI Assistant

Always-on personal AI assistant running in Docker. Uses Claude Pro via the Agent SDK, stores memories in Qdrant, communicates via Matrix/Element and local Claude Code CLI.

## Quick Start

```bash
# Install dependencies
pnpm install

# Copy environment config
cp env.example .env
# Edit .env with your tokens and domain

# Start everything
docker compose up -d
```

## Access

- **Matrix/Element**: Chat from any device via `https://your.domain`
- **Claude Code CLI**: `jonas-acp --url wss://your.domain:18789 --token <token>`
- **Dashboard**: `ssh -L 3000:127.0.0.1:3000 user@your.domain` then `http://localhost:3000`
- **Obsidian Vault**: `sshfs user@your.domain:/path/to/vault ~/Jonas-Vault`

## Development

```bash
pnpm dev          # Start development mode
pnpm build        # Build all packages
pnpm test         # Run tests
pnpm typecheck    # TypeScript check
```

## Architecture

See `CLAUDE.md` for full project documentation.
