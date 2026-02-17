# Python Channel Infrastructure

## Overview

Python channels allow Jonas to connect to communication platforms (Telegram, Slack, Discord, WhatsApp, etc.) using Python-based handlers that run as isolated child processes. This architecture keeps the Node.js core clean and allows each channel to have its own Python dependencies.

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Node.js Agent Core                              │
│  ┌───────────────────────────────────────────┐  │
│  │ ChannelRegistry                           │  │
│  │  - Loads channel metadata                 │  │
│  │  - Manages channel lifecycle              │  │
│  │  - Routes messages                        │  │
│  └───────────────────────────────────────────┘  │
│           │                                      │
│           │ stdio/JSON-RPC                       │
│           ▼                                      │
│  ┌───────────────────────────────────────────┐  │
│  │ PythonChannelProcess                      │  │
│  │  - Spawns Python handler                  │  │
│  │  - Manages JSON-RPC communication         │  │
│  │  - Handles lifecycle (start/stop/send)    │  │
│  └───────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
                    │
                    │ stdin/stdout (JSON-RPC)
                    ▼
┌─────────────────────────────────────────────────┐
│  Python Child Process                            │
│  ┌───────────────────────────────────────────┐  │
│  │ handler.py (PythonChannelHandler)         │  │
│  │  - on_start() - Initialize bot/webhook    │  │
│  │  - on_stop() - Cleanup resources          │  │
│  │  - on_send() - Send message to platform   │  │
│  │  - notify_message_received() - To agent   │  │
│  └───────────────────────────────────────────┘  │
│           │                                      │
│           │ Platform API (HTTP/WebSocket)        │
│           ▼                                      │
│  ┌───────────────────────────────────────────┐  │
│  │ Telegram/Slack/Discord SDK                │  │
│  │  - Platform-specific dependencies         │  │
│  │  - Isolated via requirements.txt          │  │
│  └───────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

## JSON-RPC Protocol

Communication between Node.js and Python uses JSON-RPC 2.0 over stdio.

### Requests (Node.js → Python)

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "config": { "pollInterval": 3 },
    "secrets": { "TELEGRAM_BOT_TOKEN": "..." }
  }
}
```

**Methods:**
- `initialize(config, secrets)` - Initialize handler with config and secrets
- `start()` - Start webhook/polling
- `stop()` - Stop and cleanup
- `send(channel_id, text)` - Send message to platform

### Responses (Python → Node.js)

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": { "status": "ready" }
}
```

### Notifications (Python → Node.js)

```json
{
  "jsonrpc": "2.0",
  "method": "message_received",
  "params": {
    "channel_id": "123456",
    "message": "Hello from Telegram!"
  }
}
```

## Creating a Python Channel

### 1. Channel Structure

```
/data/channels/telegram/
├── channel.md          # Metadata (YAML frontmatter + description)
├── config.json         # Configuration (required secrets, mode, etc.)
├── handler.py          # Python handler implementation
└── requirements.txt    # Python dependencies
```

### 2. channel.md

```markdown
---
name: Telegram
platform: telegram
version: 1.0.0
author: your-name
mode: polling
---

# Telegram Channel

Connect Jonas to Telegram using a bot token.
```

### 3. config.json

```json
{
  "requiredSecrets": ["TELEGRAM_BOT_TOKEN"],
  "mode": "polling",
  "pollInterval": 3
}
```

### 4. handler.py

```python
#!/usr/bin/env python3
import sys
import json
import asyncio
from telegram.ext import Application, MessageHandler, filters

# Import base class (provided by Jonas)
from channels.python_handler import PythonChannelHandler


class TelegramChannelHandler(PythonChannelHandler):
    async def on_start(self):
        """Initialize Telegram bot and start polling."""
        token = self.secrets.get("TELEGRAM_BOT_TOKEN")
        if not token:
            raise ValueError("Missing TELEGRAM_BOT_TOKEN")

        self.app = Application.builder().token(token).build()
        self.app.add_handler(MessageHandler(filters.TEXT, self._handle_message))

        await self.app.initialize()
        await self.app.start()
        asyncio.create_task(self._poll_loop())

    async def on_stop(self):
        """Stop Telegram bot."""
        if self.app:
            await self.app.stop()
            await self.app.shutdown()

    async def on_send(self, channel_id: str, text: str):
        """Send message to Telegram."""
        await self.app.bot.send_message(chat_id=int(channel_id), text=text)

    async def _handle_message(self, update, context):
        """Handle incoming message."""
        chat_id = str(update.message.chat_id)
        text = update.message.text
        await self.notify_message_received(chat_id, text)

    async def _poll_loop(self):
        """Start polling."""
        await self.app.updater.start_polling()
        while self._running:
            await asyncio.sleep(1)
        await self.app.updater.stop()


def main():
    handler = TelegramChannelHandler()
    asyncio.run(handler.run())


if __name__ == "__main__":
    main()
```

### 5. requirements.txt

```
python-telegram-bot==20.7
```

## Using the channel_create MCP Tool

```python
# Example: Creating a Telegram channel via MCP tool
channel_create(
    dirName="telegram",
    channelMd="""---
name: Telegram
platform: telegram
version: 1.0.0
author: jonas
mode: polling
---

# Telegram Channel
Connect Jonas to Telegram.
""",
    configJson='{"requiredSecrets":["TELEGRAM_BOT_TOKEN"],"mode":"polling","pollInterval":3}',
    handlerPy="""<handler.py content>""",
    requirementsTxt="python-telegram-bot==20.7"
)
```

## Message Flow

### Incoming Messages (Platform → Agent)

1. Platform SDK receives message (e.g., Telegram bot gets message)
2. Python handler calls `notify_message_received(channel_id, message)`
3. JSON-RPC notification sent to Node.js via stdout
4. Node.js forwards message to agent API at `POST /api/chat`
5. Agent processes message and generates response
6. Response sent back to platform via `send(channel_id, text)`

### Outgoing Messages (Agent → Platform)

1. Agent calls `channelRegistry.sendMessage(name, channelId, text)`
2. Node.js sends JSON-RPC `send` request to Python process
3. Python handler's `on_send(channel_id, text)` called
4. Platform SDK sends message (e.g., Telegram bot.send_message)

## Python Base Class API

### `PythonChannelHandler`

**Properties:**
- `self.config` - Channel configuration (from config.json)
- `self.secrets` - Encrypted secrets (bot tokens, API keys)
- `self._running` - Boolean flag indicating if channel is running

**Methods to Override:**
- `async on_start()` - Called when channel starts
- `async on_stop()` - Called when channel stops
- `async on_send(channel_id: str, text: str)` - Called to send message

**Helper Methods:**
- `await notify_message_received(channel_id, message)` - Send message to agent
- `await _send_stdout(obj)` - Send JSON-RPC message (internal)

## Lifecycle Management

### Start Sequence

1. User enables channel via dashboard
2. User clicks "Start" button
3. `ChannelRegistry.startChannel()` called
4. `PythonChannelProcess` spawns Python handler
5. JSON-RPC `initialize` request sent with config and secrets
6. JSON-RPC `start` request sent
7. Python handler's `on_start()` executes
8. Channel state set to `running`

### Stop Sequence

1. User clicks "Stop" button
2. `ChannelRegistry.stopChannel()` called
3. JSON-RPC `stop` request sent
4. Python handler's `on_stop()` executes
5. Python process terminated
6. Channel state set to `stopped`

## Dependency Management

Python dependencies are installed automatically when the channel is created or loaded:

```bash
pip3 install --break-system-packages -q -r /data/channels/<name>/requirements.txt
```

This runs during:
- Channel creation (via `channel_create` MCP tool)
- Agent startup (when loading existing channels)

## Error Handling

### Python Side

```python
async def on_send(self, channel_id: str, text: str):
    try:
        await self.app.bot.send_message(chat_id=int(channel_id), text=text)
    except Exception as e:
        sys.stderr.write(f"Send failed: {e}\n")
        sys.stderr.flush()
        raise  # Propagate to Node.js
```

### Node.js Side

Errors are logged and channel state is set to `error`:

```typescript
try {
  await handler.start();
  channel.state = 'running';
} catch (err) {
  channel.state = 'error';
  channel.error = err.message;
  log.error({ channel: name, err }, 'Failed to start channel');
  throw err;
}
```

## Example Channels

### Telegram (Polling)

See `/services/agent/src/channels/examples/telegram-channel-template.py`

### Slack (Webhook)

```python
class SlackChannelHandler(PythonChannelHandler):
    async def on_start(self):
        """Start webhook server."""
        from aiohttp import web

        self.app = web.Application()
        self.app.router.add_post('/slack/events', self._handle_webhook)

        port = self.config.get('port', 3003)
        self.runner = web.AppRunner(self.app)
        await self.runner.setup()

        site = web.TCPSite(self.runner, '0.0.0.0', port)
        await site.start()

    async def _handle_webhook(self, request):
        """Handle Slack webhook."""
        data = await request.json()

        if data.get('type') == 'url_verification':
            return web.json_response({'challenge': data['challenge']})

        event = data.get('event', {})
        if event.get('type') == 'message':
            channel_id = event['channel']
            text = event['text']
            await self.notify_message_received(channel_id, text)

        return web.Response(text='ok')
```

## Migration from JavaScript Handlers

To migrate an existing JavaScript handler to Python:

1. Create `handler.py` implementing `PythonChannelHandler`
2. Add `requirements.txt` with Python dependencies
3. Delete `handler.js`
4. Restart channel

The registry automatically detects and prefers Python handlers over JavaScript.

## Troubleshooting

### Channel won't start

- Check logs: `docker logs jonas-agent`
- Verify secrets are set: `channel_set_value` MCP tool
- Check Python dependencies installed: `pip3 list`

### Messages not received

- Check stderr output in logs
- Verify webhook URL or polling interval
- Test platform API credentials independently

### High CPU usage

- Reduce poll interval in config.json
- Use webhooks instead of polling when possible
- Check for infinite loops in handler code

## Best Practices

1. **Use Python for new channels** - Avoid polluting Node.js core with channel dependencies
2. **Prefer webhooks over polling** - Lower latency, less resource usage
3. **Handle errors gracefully** - Log to stderr, raise exceptions for critical failures
4. **Validate secrets in on_start()** - Fail fast if credentials missing
5. **Clean up resources in on_stop()** - Close connections, stop background tasks
6. **Use asyncio properly** - Avoid blocking operations, use `await` for I/O

## Files Added

- `services/agent/src/channels/python-handler.py` - Base class for Python handlers
- `services/agent/src/channels/python-process.ts` - Process manager for Python handlers
- `services/agent/src/channels/examples/telegram-channel-template.py` - Example implementation
- Updated `services/agent/src/channels/registry.ts` - Support for Python handlers
- Updated `services/agent/src/mcp-server.ts` - `channel_create` tool with Python support
- Updated `services/agent/src/api/server.ts` - API endpoint with Python support
