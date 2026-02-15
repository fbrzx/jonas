# Installable Channels Implementation

## Summary

Successfully implemented the installable channels system that allows communication platforms (like Telegram) to be installed, configured, and managed via the dashboard without requiring Docker rebuilds or redeployments.

## What Was Implemented

### 1. Core Types (`packages/shared/src/types/channel.ts`)
- `PlatformChannel` - Main channel type with metadata, status, state, config, and secrets
- `ChannelStatus` - enabled | disabled
- `ChannelState` - stopped | starting | running | error
- `ChannelMetadata` - Name, platform, version, author, description, mode
- `ChannelConfig` - Required/optional secrets, mode, port, poll interval
- `ChannelHandler` - Interface for channel implementations (start, stop, send)

### 2. Channel Registry (`services/agent/src/channels/registry.ts`)
Mirrors the SkillRegistry pattern with the following capabilities:
- **Load channels** from `/data/channels/` directory
- **Lifecycle management**: enable, disable, start, stop
- **State persistence** via `/data/channels.json`
- **Secret management** via crypto-store (AES-256-GCM encryption)
- **Import/Export**: Package channels as `.zip` files for portability
- **Dynamic loading**: Channels are ES modules loaded via `import()`
- **In-process execution**: Channels run in same process for simplicity

### 3. Agent Integration (`services/agent/src/index.ts`)
- Initialize ChannelRegistry after SkillRegistry
- Auto-start enabled channels on boot
- Pass registry to API server
- Graceful shutdown: stop all running channels

### 4. API Endpoints (`services/agent/src/api/server.ts`)
Complete REST API for channel management:
- `GET /api/channels` - List all channels
- `GET /api/channels/:name` - Get channel details
- `POST /api/channels` - Create new channel
- `POST /api/channels/:name/enable|disable` - Toggle enabled status
- `POST /api/channels/:name/start|stop` - Start/stop channel handler
- `PUT /api/channels/:name/values` - Store secret value
- `DELETE /api/channels/:name/values/:key` - Remove secret
- `DELETE /api/channels/:name` - Delete channel
- `GET /api/channels/:name/export` - Download channel as `.zip`
- `POST /api/channels/import` - Upload `.zip` to install channel
- `POST /api/channels/:name/send` - Send message via channel

### 5. Dashboard UI (`apps/dashboard/src/routes/channels.ts`)
Full HTMX-powered UI with:
- **List view**: Table showing all channels with inline enable/disable/start/stop actions
- **Detail view**: Channel metadata, configuration form, secret management
- **Import/Export**: Upload `.zip` packages, download individual channels
- **Real-time updates**: HTMX swaps update UI without page refreshes
- **Navigation**: Added "Channels" link to dashboard nav

### 6. Telegram Channel Template
Created initial Telegram channel in `/data/channels/telegram/`:

**`channel.md`**: YAML frontmatter with metadata
```yaml
---
name: Telegram Bot
platform: telegram
version: 1.0.0
author: jonas-team
mode: both
---
```

**`config.json`**: Configuration schema
```json
{
  "requiredSecrets": ["TELEGRAM_BOT_TOKEN"],
  "optionalSecrets": ["TELEGRAM_WEBHOOK_SECRET", "TELEGRAM_WEBHOOK_URL"],
  "mode": "webhook",
  "port": 3002
}
```

**`handler.js`**: Channel handler implementation
- Ported from `services/telegram-bot`
- Supports webhook and polling modes
- Implements ChannelHandler interface (start, stop, send)
- Uses `sendToAgent` callback to communicate with agent

### 7. Docker Configuration Updates
- **Removed** `telegram-bot` service from `docker-compose.yml`
- Telegram channel now runs inside `agent` service
- Port 3002 exposed by agent when telegram channel starts

## Architecture

### Channel Storage Structure
```
/data/channels/telegram/
├── channel.md       # YAML frontmatter + description
├── config.json      # Platform-specific config
├── handler.js       # Node.js module implementing ChannelHandler
└── vault.enc        # Encrypted secrets (auto-created)
```

### Communication Flow
```
Telegram API → handler.js → sendToAgent() → Agent API (/api/chat)
                                              ↓ Process with Claude
Agent API → handler.js → send() → Telegram API
```

### Handler Interface
Every channel must export an `initialize` function:
```javascript
export async function initialize(config, secrets, sendToAgent) {
  return {
    start: async () => { /* start webhook or polling */ },
    stop: async () => { /* cleanup */ },
    send: async (channelId, text) => { /* send to platform */ }
  };
}
```

## Key Features

### Portability
- **Export**: Download any channel as a `.zip` file
- **Import**: Upload `.zip` to install on another Jonas instance
- **Secrets excluded**: Exported packages don't include `vault.enc` (must reconfigure)
- **Share**: Channel packages can be shared across Jonas instances

### Security
- Secrets encrypted via AES-256-GCM in per-channel `vault.enc`
- Managed through crypto-store (same as skills)
- Never included in exported `.zip` files
- Stored separately from channel code

### Migration from telegram-bot Service
The standalone `services/telegram-bot` service has been removed in favor of the installable telegram channel. To migrate:

1. **Configure token**: Visit dashboard → Channels → telegram
2. **Set TELEGRAM_BOT_TOKEN**: Use the config form to store the bot token
3. **Enable and start**: Click enable, then start
4. **Verify**: Send a message to your Telegram bot

The token is no longer in the `.env` file - it's encrypted in the vault.

## Usage

### Install a Channel
1. Go to dashboard: http://localhost:3000/channels
2. Click "Import Channel"
3. Upload a `.zip` file
4. Configure required secrets
5. Enable and start the channel

### Export a Channel
1. Go to channel detail page
2. Click "Export (.zip)" button
3. Share the `.zip` file with others

### Configure Secrets
1. Open channel detail page
2. Select secret key from dropdown
3. Enter value in textarea
4. Click "Save"
5. Configured secrets appear in the list below

### Create a New Channel
Channels can be created programmatically via API:
```bash
curl -X POST http://localhost:3001/api/channels \
  -H 'Content-Type: application/json' \
  -d '{
    "dirName": "slack",
    "metadata": {
      "name": "Slack Bot",
      "platform": "slack",
      "version": "1.0.0",
      "author": "your-name",
      "description": "Slack integration"
    },
    "config": {
      "requiredSecrets": ["SLACK_BOT_TOKEN"],
      "mode": "webhook"
    }
  }'
```

## Files Created

### Core Implementation
- `packages/shared/src/types/channel.ts` (NEW)
- `services/agent/src/channels/registry.ts` (NEW)
- `apps/dashboard/src/routes/channels.ts` (NEW)

### Telegram Channel Template
- `.volumes/agent-data/channels/telegram/channel.md` (NEW)
- `.volumes/agent-data/channels/telegram/config.json` (NEW)
- `.volumes/agent-data/channels/telegram/handler.js` (NEW)

## Files Modified

- `packages/shared/src/types/index.ts` - Export channel types
- `services/agent/src/index.ts` - Initialize and manage channels
- `services/agent/src/api/server.ts` - Add channel API endpoints
- `services/agent/package.json` - Add `yaml` dependency
- `apps/dashboard/src/index.ts` - Mount channels routes
- `apps/dashboard/src/views/layout.ts` - Add Channels nav link
- `docker-compose.yml` - Remove telegram-bot service

## Next Steps

### For Users
1. **Test telegram channel**:
   - Configure TELEGRAM_BOT_TOKEN via dashboard
   - Enable and start the channel
   - Send a test message

2. **Create new channels**:
   - Use telegram as a template
   - Implement handler.js for other platforms (Slack, Discord, WhatsApp, etc.)
   - Package and share via `.zip` export

### Future Enhancements
- **Channel marketplace**: Public registry of installable channels
- **Auto-updates**: Check for new versions of installed channels
- **Health checks**: Monitor channel status and auto-restart on errors
- **Metrics**: Track message volume, response times per channel
- **Multi-instance**: Support multiple instances of same channel type (e.g., multiple Telegram bots)

## Build Status

✅ Build successful
✅ All packages compiled
✅ No TypeScript errors
✅ Ready for deployment

## Testing Checklist

- [ ] Start agent service
- [ ] Verify telegram channel loaded
- [ ] Configure bot token via dashboard
- [ ] Enable and start telegram channel
- [ ] Send message to bot
- [ ] Verify response received
- [ ] Export telegram channel as `.zip`
- [ ] Delete telegram channel
- [ ] Re-import from `.zip`
- [ ] Reconfigure token
- [ ] Test again

## Notes

- Channels run **in-process** (not as separate services)
- Uses same crypto-store as skills for secrets
- Channel state persisted in `/data/channels.json`
- Handlers are dynamically imported ES modules
- Export excludes secrets - must reconfigure after import
