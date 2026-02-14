# Jonas — Personal AI Assistant

Always-on personal AI assistant running in Docker. Supports both Claude (via CLI) and Ollama (local models), stores memories in Qdrant, uses configurable skills and performs scheduled tasks.

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

## Model Providers

Jonas supports two model providers:

### Claude (default)
Uses Claude Pro via OAuth token and the Claude Code CLI:
```bash
MODEL_PROVIDER=claude
AGENT_DEFAULT_MODEL=claude-sonnet-4-5-20250929
```

### Ollama (local models)
Run local models like Qwen, Llama, etc:
```bash
MODEL_PROVIDER=ollama
OLLAMA_BASE_URL=http://ollama:11434
OLLAMA_MODEL=qwen2.5-coder:latest

# Start Ollama service
docker compose up -d ollama

# Pull a model
docker compose exec ollama ollama pull qwen2.5-coder:latest
```

You can also configure the model provider via the dashboard UI at runtime. See `.claude/docs/environment-variables.md` for all configuration options.

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
