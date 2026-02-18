# Environment Variables

This document lists all environment variables used by the Jonas agent.

## Model Provider Configuration

### Provider Selection
- `MODEL_PROVIDER` - Which model provider to use (default: `claude`)
  - Options: `claude`, `ollama`

### Claude Configuration (when `MODEL_PROVIDER=claude`)
- `CLAUDE_MODEL` - Claude model to use (default: `claude-sonnet-4-5-20250929`)
- `CLAUDE_CODE_OAUTH_TOKEN` - OAuth token for Claude Pro access (required)

### Ollama Configuration (when `MODEL_PROVIDER=ollama`)
- `OLLAMA_BASE_URL` - Base URL for Ollama API (default: `http://localhost:11434`)
- `OLLAMA_MODEL` - Model name to use (default: `qwen2.5-coder:latest`)

## Other Configuration

### Memory & Embeddings
- `QDRANT_URL` - Qdrant vector database URL (default: `http://localhost:6333`)
- `VOYAGE_API_KEY` - Voyage AI API key for embeddings (required)

### Matrix Chat
- `MATRIX_HOMESERVER` - Matrix homeserver URL
- `MATRIX_BOT_USERNAME` - Matrix bot username
- `MATRIX_BOT_PASSWORD` - Matrix bot password (required)

### Gateway
- `GATEWAY_PORT` - WebSocket gateway port (default: `18789`)
- `GATEWAY_TOKEN` - Shared secret for WebSocket gateway upgrades via `/ws?token=...` (required). Missing/invalid token rejects connections.

### Dashboard
- `DASHBOARD_PORT` - Dashboard HTTP port (default: `3000`)
- `DASHBOARD_TOKEN` - Dashboard authentication token (required). If unset, dashboard access is blocked.

### Telegram Bot
- `TELEGRAM_BOT_TOKEN` - Telegram bot token from @BotFather (required)
- `TELEGRAM_MODE` - Bot mode: `webhook` or `polling` (default: `webhook`)
- `TELEGRAM_WEBHOOK_URL` - Public webhook URL (e.g., `https://your-domain.com/webhook`) - for webhook mode
- `TELEGRAM_WEBHOOK_SECRET` - Optional secret token for webhook verification - for webhook mode
- `TELEGRAM_POLL_INTERVAL` - Polling interval in ms (default: `1000`) - for polling mode
- `TELEGRAM_BOT_PORT` - Webhook server port (default: `3002`) - for webhook mode

### General
- `AGENT_PORT` - Agent API port (default: `3001`)
- `VAULT_PATH` - Path to encrypted vault storage (default: `/data/vault`)
- `DOMAIN` - Domain name for production deployment

## Runtime Configuration

Model provider settings can also be configured at runtime via the dashboard UI.
Changes are persisted to `/data/model-config.json` and override environment variables.

Example `/data/model-config.json`:
```json
{
  "provider": "ollama",
  "ollama": {
    "baseUrl": "http://ollama:11434",
    "model": "qwen2.5-coder:7b"
  }
}
```

Note: Agent restart required after changing model provider settings.
