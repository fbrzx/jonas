# Claude Desktop Integration Guide

## Overview

Connect Claude Desktop to Jonas via the MCP Gateway Bridge, giving you access to all Jonas capabilities (memory, vault, skills, tasks) directly from Claude Desktop.

---

## Architecture

```
┌──────────────────┐
│ Claude Desktop   │
│ (MCP Client)     │
└────────┬─────────┘
         │ stdio (MCP protocol)
         ↓
┌──────────────────┐
│ jonas-mcp        │  MCP Gateway Bridge
│ (stdio ↔ WS)     │
└────────┬─────────┘
         │ WebSocket
         ↓
┌──────────────────┐
│ Gateway Service  │  Port 18789
│ (Token Auth)     │
└────────┬─────────┘
         │ HTTP
         ↓
┌──────────────────┐
│ Jonas Agent      │
│ (Claude + Tools) │
└──────────────────┘
```

---

## Prerequisites

1. **Jonas running**: Gateway service must be running
2. **Claude Desktop installed**: Download from claude.ai
3. **Gateway token configured**: `GATEWAY_TOKEN` set in `.env`

---

## Installation

### Step 1: Build MCP Bridge

```bash
# From Jonas project root
pnpm install
pnpm build

# Link globally
cd packages/mcp-gateway-bridge
pnpm link --global
```

Verify installation:
```bash
jonas-mcp --help
# Should show usage instructions
```

---

### Step 2: Configure Claude Desktop

**Location:** `~/.config/Claude/claude_desktop_config.json`

**For Local Development (same machine):**
```json
{
  "mcpServers": {
    "jonas": {
      "command": "jonas-mcp",
      "args": [
        "--url", "ws://localhost:18789",
        "--token", "YOUR_GATEWAY_TOKEN_HERE"
      ]
    }
  }
}
```

**For Remote Access (via SSH tunnel):**

```bash
# Terminal 1: Create persistent SSH tunnel
ssh -L 18789:localhost:18789 -N user@your-server.com
```

Then use same config as local development (connects via tunnel).

**For Production (TLS):**
```json
{
  "mcpServers": {
    "jonas": {
      "command": "jonas-mcp",
      "args": [
        "--url", "wss://your-domain.com:18789",
        "--token", "YOUR_GATEWAY_TOKEN_HERE"
      ]
    }
  }
}
```

---

### Step 3: Get Your Gateway Token

```bash
# On your Jonas server
grep GATEWAY_TOKEN .env

# Output: GATEWAY_TOKEN=abc123def456...
```

**Security Warning:** This token grants full access to Jonas. Keep it secret!

---

### Step 4: Restart Claude Desktop

1. Quit Claude Desktop completely
2. Relaunch Claude Desktop
3. Look for "jonas" in the MCP servers list (usually bottom right)

---

## Available Tools

Once connected, Claude Desktop will have access to these tools:

### 1. `jonas_chat`
**Purpose:** Send a message to Jonas and get a response

**Example:**
```
Can you check my email for anything urgent?
→ Uses jonas_chat tool
→ Jonas runs gmail skill
→ Returns summary
```

**What Jonas Can Do:**
- Access your memories (recall past conversations)
- Read/write to your Obsidian vault
- Execute enabled skills (gmail, news, etc.)
- Schedule tasks
- Manage channels

---

### 2. `jonas_reset_session`
**Purpose:** Reset the conversation session (clear context)

**Use when:**
- Starting a completely new topic
- Jonas seems confused about context
- You want to clear sensitive information from context

---

### 3. `jonas_status`
**Purpose:** Check if Jonas is online and healthy

---

## Usage Examples

### Example 1: Morning Briefing

**You:** *Can you give me a morning briefing?*

**Claude Desktop:**
```
I'll ask Jonas for your morning briefing.
[Uses jonas_chat tool]

Jonas says:
Good morning! Here's your briefing:
- 3 new emails (1 urgent from Sarah)
- Calendar: Team meeting at 10am, 1:1 with Bob at 2pm
- Top news: [headlines from news skill]
- Weather: Sunny, 72°F
```

---

### Example 2: Note Taking

**You:** *Remember that I prefer React over Vue for new projects*

**Claude Desktop:**
```
I'll have Jonas remember that.
[Uses jonas_chat tool]

Jonas stored this in memory as a semantic preference.
You can ask Jonas to recall this later when discussing frameworks.
```

---

### Example 3: Task Scheduling

**You:** *Schedule a weekly summary of my inbox every Friday at 5pm*

**Claude Desktop:**
```
I'll set that up through Jonas.
[Uses jonas_chat tool]

Jonas created a scheduled task:
- Name: Weekly Inbox Summary
- Schedule: Every Friday at 5pm
- Action: Summarize inbox and send to dashboard
Task ID: task_abc123
```

---

## Troubleshooting

### Tool Not Appearing

**Problem:** "jonas" doesn't show in MCP servers list

**Solutions:**
1. Check config syntax: `cat ~/.config/Claude/claude_desktop_config.json | jq`
2. Verify jonas-mcp is installed: `which jonas-mcp`
3. Check Claude Desktop logs:
   - macOS: `~/Library/Logs/Claude/`
   - Windows: `%APPDATA%\Claude\logs\`
   - Linux: `~/.config/Claude/logs/`

---

### Connection Failed

**Problem:** Tool calls fail with "Not connected to gateway"

**Solutions:**
1. Verify gateway is running: `curl http://localhost:18789/health`
2. Check token matches: `grep GATEWAY_TOKEN .env`
3. Test jonas-mcp manually:
   ```bash
   jonas-mcp --url ws://localhost:18789 --token YOUR_TOKEN
   # Should connect without errors
   ```

---

### SSH Tunnel Issues

**Problem:** Connection works locally but not via tunnel

**Solutions:**
1. Verify tunnel is active: `netstat -an | grep 18789`
2. Use persistent tunnel: `ssh -L 18789:localhost:18789 -N -f user@server`
3. Check firewall rules on server

---

### Slow Responses

**Problem:** Jonas takes a long time to respond

**Possible causes:**
- Jonas is processing a complex request
- Skills are rate-limited (e.g., Voyage AI embeddings)
- Network latency (remote connection)

**Solutions:**
- Use `jonas_status` to check if Jonas is busy
- Check Jonas logs: `docker compose logs -f agent`
- For remote access, consider increasing timeout in gateway config

---

## Advanced Configuration

### Multiple Jonas Instances

If you have multiple Jonas instances (dev, prod), configure both:

```json
{
  "mcpServers": {
    "jonas-dev": {
      "command": "jonas-mcp",
      "args": ["--url", "ws://localhost:18789", "--token", "DEV_TOKEN"]
    },
    "jonas-prod": {
      "command": "jonas-mcp",
      "args": ["--url", "wss://jonas.example.com:18789", "--token", "PROD_TOKEN"]
    }
  }
}
```

---

### Custom Session Storage

By default, the bridge creates a new session for each Claude Desktop conversation. Sessions are ephemeral and reset when Claude Desktop restarts.

To persist sessions across restarts, you could modify `packages/mcp-gateway-bridge/src/index.ts` to use session storage similar to the CLI tool.

---

### Debugging MCP Communication

To see MCP protocol messages:

```bash
# Run jonas-mcp directly with debug output
jonas-mcp --url ws://localhost:18789 --token YOUR_TOKEN 2>&1 | tee mcp-debug.log
```

This will log all stderr output (including MCP protocol messages) to both console and file.

---

## Comparison: Direct MCP vs Gateway Bridge

| Approach | Direct MCP Server | Gateway Bridge (This Guide) |
|----------|-------------------|----------------------------|
| **Runs On** | Jonas server | Your local machine |
| **Connection** | Direct to Docker | Via WebSocket |
| **Setup** | Complex (Docker access) | Simple (just install CLI) |
| **Remote Access** | Difficult | Easy (SSH tunnel) |
| **Latency** | Lower | Slightly higher |
| **Use Case** | Same-machine only | Any access pattern |

---

## Security Considerations

### Token Management

1. **Never commit tokens to git**
   - Keep `GATEWAY_TOKEN` in `.env` (gitignored)
   - Don't share Claude Desktop config with tokens

2. **Use different tokens per environment**
   ```bash
   # Development
   GATEWAY_TOKEN_DEV=$(openssl rand -hex 32)

   # Production
   GATEWAY_TOKEN_PROD=$(openssl rand -hex 32)
   ```

3. **Rotate tokens periodically**
   - Update `.env`
   - Update Claude Desktop config
   - Restart gateway: `docker compose restart gateway`

---

### Network Security

1. **SSH Tunnels for Remote Access**
   - Never expose gateway port to internet directly
   - Use SSH tunnel or VPN

2. **TLS for Production**
   - Configure nginx with valid SSL cert
   - Use `wss://` (not `ws://`)

3. **Firewall Rules**
   ```bash
   # Only allow localhost connections
   ufw deny 18789
   ufw allow from 127.0.0.1 to any port 18789
   ```

---

## Performance Optimization

### Reduce Latency

1. **Co-locate Jonas and Claude Desktop**
   - Run Jonas locally during development
   - Use local Docker instead of remote

2. **Optimize Skills**
   - Disable unused skills
   - Cache frequently accessed data

3. **Connection Pooling**
   - The bridge maintains a persistent WebSocket connection
   - Sessions are reused across multiple tool calls

---

## Limitations

1. **Single Tool Interface**
   - Unlike the full MCP server, the bridge exposes a single `jonas_chat` tool
   - This simplifies the interface but means tool calls go through Jonas's chat flow

2. **No Streaming in MCP**
   - MCP protocol requires complete responses
   - Bridge buffers streaming output before returning

3. **Session Scope**
   - Each Claude Desktop conversation creates a new session
   - Sessions don't persist across Claude Desktop restarts

---

## Future Enhancements

### Planned Features

- [ ] Expose individual Jonas tools (memory, vault, etc.) as separate MCP tools
- [ ] Persistent session storage across restarts
- [ ] Connection retry logic
- [ ] Performance metrics
- [ ] Multiple concurrent requests

### Contributing

To enhance the bridge:
1. Edit `packages/mcp-gateway-bridge/src/index.ts`
2. Build: `pnpm build`
3. Test: restart Claude Desktop
4. Submit PR with description of changes

---

## Next Steps

1. **Test the connection**: Send a simple message to Jonas
2. **Explore capabilities**: Ask Jonas what skills are available
3. **Customize**: Enable skills you need, disable others
4. **Automate**: Use Jonas for recurring tasks (email summaries, etc.)

---

**Last Updated:** 2026-02-16
**Author:** Jonas Team
**Related Docs:** `gateway-cli-usage.md`, `gateway-protocol.md`
