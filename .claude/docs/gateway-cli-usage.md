# Gateway CLI Usage Guide

## Overview

The Jonas Gateway allows you to chat with your personal assistant from the command line using the `jonas-acp` CLI tool. This provides a lightweight, terminal-based interface to all Jonas capabilities.

---

## Architecture

```
┌─────────────────┐
│  Your Terminal  │
│  (jonas-acp)    │
└────────┬────────┘
         │ WebSocket (wss://)
         ↓
┌─────────────────┐
│  Gateway (WS)   │  Port 18789
│  Token Auth     │
└────────┬────────┘
         │ HTTP
         ↓
┌─────────────────┐
│  Agent (Jonas)  │
│  Claude + Tools │
└─────────────────┘
```

---

## Installation

### Option 1: Use from Monorepo (Development)

```bash
# From project root
pnpm install
pnpm build

# Run directly
node packages/acp-bridge/dist/index.js --url <URL> --token <TOKEN>
```

### Option 2: Global Installation (Recommended)

```bash
# From project root
cd packages/acp-bridge
pnpm link --global

# Now available globally
jonas-acp --url <URL> --token <TOKEN>
```

### Option 3: Create Alias

```bash
# Add to ~/.bashrc or ~/.zshrc
alias jonas-acp="node /path/to/jonas/packages/acp-bridge/dist/index.js"

# Reload shell
source ~/.bashrc
```

---

## Configuration

### 1. Set Gateway Token

The `GATEWAY_TOKEN` must be configured in your `.env` file:

```bash
# Generate a secure random token
GATEWAY_TOKEN=$(openssl rand -hex 32)
echo "GATEWAY_TOKEN=$GATEWAY_TOKEN" >> .env

# Restart gateway service
docker compose restart gateway
```

**Security Note:** This token grants full access to Jonas. Keep it secret and never commit it to version control.

---

### 2. Verify Gateway is Running

```bash
# Check gateway health
curl http://localhost:18789/health

# Expected response:
# {"status":"ok","service":"gateway"}
```

---

## Usage

### Local Development (Same Machine)

```bash
jonas-acp \
  --url ws://localhost:18789 \
  --token YOUR_GATEWAY_TOKEN_HERE
```

### Remote Access via SSH Tunnel

```bash
# Terminal 1: Create SSH tunnel
ssh -L 18789:localhost:18789 user@your-server.com

# Terminal 2: Connect via tunnel
jonas-acp \
  --url ws://localhost:18789 \
  --token YOUR_GATEWAY_TOKEN_HERE
```

### Remote Access via TLS (Production)

```bash
# Requires nginx with SSL termination configured
jonas-acp \
  --url wss://your-domain.com:18789 \
  --token YOUR_GATEWAY_TOKEN_HERE
```

---

## Session Management

The CLI maintains a persistent session in `~/.jonas/session.json`. This allows:
- Conversation continuity across restarts
- Memory recall from previous conversations
- Persistent context

**Reset session:**
```bash
rm ~/.jonas/session.json
```

---

## Features

### 1. Interactive Chat

Simply type your messages and press Enter:

```
$ jonas-acp --url ws://localhost:18789 --token abc123
Connected to Jonas gateway

> Hey Jonas, what's on my calendar today?
[Jonas responds with calendar summary]

> Send a summary to my Telegram
[Jonas sends message via Telegram skill]
```

### 2. Tool Execution

Jonas can execute tools automatically:

```
> Remember that I prefer dark mode
[tool] memory_remember({"content":"User prefers dark mode","category":"semantic"})
[result] {"success":true,"id":"mem_abc123"}
Done! I'll remember that you prefer dark mode.
```

### 3. Multi-turn Conversations

All context is preserved within a session:

```
> What did I ask you yesterday about the project?
[Jonas recalls from memory]

> Can you expand on that?
[Jonas uses previous context]
```

---

## Troubleshooting

### Connection Refused

```
Gateway error: connect ECONNREFUSED
```

**Solutions:**
1. Verify gateway is running: `docker compose ps gateway`
2. Check port is exposed: `netstat -an | grep 18789`
3. Verify token is set: `echo $GATEWAY_TOKEN`

---

### Authentication Failed

```
Disconnected from Jonas gateway
```

**Solutions:**
1. Check token matches `.env`: `grep GATEWAY_TOKEN .env`
2. Restart gateway after changing token: `docker compose restart gateway`
3. Ensure token doesn't contain special characters that need escaping

---

### Session Errors

```
[error] Session not found
```

**Solutions:**
1. Delete session file: `rm ~/.jonas/session.json`
2. Reconnect to create new session

---

### SSL/TLS Errors (wss://)

```
Error: self signed certificate
```

**Solutions:**
1. For development, use `ws://` instead of `wss://`
2. For production, ensure nginx has valid SSL certificate
3. For self-signed certs, you may need to accept certificate manually

---

## Advanced Configuration

### Environment Variables

You can set defaults via environment variables:

```bash
# In ~/.bashrc or ~/.zshrc
export JONAS_GATEWAY_URL="wss://your-domain.com:18789"
export JONAS_GATEWAY_TOKEN="your-token-here"

# Then run without args
jonas-acp
```

### Custom Session Path

The session file location is hardcoded to `~/.jonas/session.json`. To use a different location, you would need to modify the source code in `packages/acp-bridge/src/session.ts`.

---

## Protocol Details

### WebSocket Frame Format

The gateway uses a JSON-RPC style protocol:

**Request (Client → Gateway):**
```json
{
  "type": "req",
  "id": "req_abc123",
  "method": "chat.send",
  "params": {
    "message": "Hello Jonas",
    "sessionKey": "sess_xyz789"
  }
}
```

**Response (Gateway → Client):**
```json
{
  "type": "res",
  "id": "req_abc123",
  "result": { "status": "complete" }
}
```

**Events (Gateway → Client, streaming):**
```json
{
  "type": "evt",
  "event": "chat.stream",
  "payload": {
    "kind": "delta",
    "text": "Hello! How can I help?"
  }
}
```

### Supported Methods

- `chat.send` - Send a message to Jonas
- `chat.abort` - Abort ongoing request
- `sessions.list` - List active sessions
- `sessions.reset` - Reset current session
- `status` - Get agent status

---

## Examples

### Morning Briefing Script

```bash
#!/bin/bash
# morning-briefing.sh

echo "What's on my schedule today?" | jonas-acp \
  --url ws://localhost:18789 \
  --token $JONAS_GATEWAY_TOKEN
```

### One-off Commands

```bash
# Quick question without interactive mode
echo "What's the weather?" | jonas-acp --url ws://localhost:18789 --token $TOKEN
```

### Integration with Other Tools

```bash
# Pipe command output to Jonas
git log --oneline -5 | jonas-acp --url ws://localhost:18789 --token $TOKEN
```

---

## Security Best Practices

1. **Never commit tokens**: Add `GATEWAY_TOKEN` to `.env`, ensure `.env` is in `.gitignore`
2. **Use SSH tunnels for remote access**: Don't expose gateway port to public internet without TLS
3. **Rotate tokens periodically**: Generate new token, update `.env`, restart gateway
4. **Use separate tokens per device** (future enhancement): Currently single token, but you could run multiple gateway instances
5. **Monitor access logs**: Check gateway logs for unauthorized access attempts

---

## Comparison: CLI vs Dashboard vs Matrix

| Feature | CLI (`jonas-acp`) | Dashboard (Web) | Matrix (Chat) |
|---------|-------------------|-----------------|---------------|
| **Access** | Terminal | Browser (SSH tunnel) | Any device |
| **Setup** | Install CLI | SSH tunnel | Matrix client |
| **Use Case** | Scripts, automation | Management, config | Mobile, casual |
| **Auth** | Token in command | Token in cookie | Bot password |
| **Persistence** | Session file | Server-side | Room history |

---

## Next Steps

- **Claude Desktop Integration**: See `mcp-gateway-bridge.md` for connecting Claude Desktop
- **API Reference**: See `gateway-protocol.md` for full protocol specification
- **Skill Development**: Use the CLI to test custom skills during development

---

**Last Updated:** 2026-02-16
**Author:** Jonas Team
