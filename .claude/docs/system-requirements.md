# Jonas Agent - System Requirements

This document specifies the infrastructure requirements for running the Jonas AI agent.

## Minimum Requirements

### Operating System
- **Supported**: Ubuntu 22.04 LTS or later, Debian 12+
- **Architecture**: x86_64 (amd64)
- **Kernel**: Linux 5.15+

### Hardware
- **CPU**: 2 cores (4 recommended)
- **RAM**: 4 GB (8 GB recommended)
- **Storage**: 20 GB free space
  - 5 GB for Docker images
  - 5 GB for application data
  - 10 GB for logs, conversations, vault

### Network
- **Connectivity**: Stable internet connection
- **Bandwidth**: 10 Mbps+ recommended
- **Latency**: <200ms to Anthropic API (api.anthropic.com)
- **DNS**: Functional DNS resolution

## Recommended Configuration

### Production VM
- **OS**: Ubuntu 24.04 LTS
- **CPU**: 4 cores
- **RAM**: 8 GB
- **Storage**: 50 GB SSD
- **Network**: Gigabit ethernet, low latency
- **Region**: Close to Anthropic API servers (US)

### Development VM
- **OS**: Ubuntu 22.04 LTS or later
- **CPU**: 2 cores
- **RAM**: 4 GB
- **Storage**: 30 GB
- **Network**: Standard broadband

## Required Software

### Docker
```bash
# Minimum versions
Docker Engine: 24.0.0+
Docker Compose: 2.20.0+

# Verify installation
docker --version
docker compose version
```

### Other Dependencies
- **OpenSSH Server**: For remote administration
- **Git**: For deployment and updates
- **curl/wget**: For API testing
- **jq**: For JSON parsing (optional)

### Installation Commands (Ubuntu)

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER

# Install Docker Compose (if not included)
sudo apt install docker-compose-plugin

# Install utilities
sudo apt install git openssh-server curl jq -y

# Enable SSH
sudo systemctl enable ssh
sudo systemctl start ssh
```

## Network Ports

### External (Public)
- **22** - SSH (secure admin access)
- **80** - HTTP (optional, for Let's Encrypt)
- **443** - HTTPS (optional, for production reverse proxy)

### Internal (Docker network)
- **3001** - Agent API
- **3000** - Dashboard (bind 127.0.0.1 only)
- **6333** - Qdrant vector database
- **18789** - Gateway WebSocket

### Firewall Configuration

```bash
# UFW (recommended)
sudo ufw allow 22/tcp      # SSH
sudo ufw allow 80/tcp      # HTTP (optional)
sudo ufw allow 443/tcp     # HTTPS (optional)
sudo ufw enable

# Verify
sudo ufw status
```

## Storage Layout

### Docker Volumes
```
/var/lib/docker/volumes/
└── jonas_agent-data/
    ├── conversations.db      # SQLite database
    ├── audit.db             # Audit logs (Phase 7)
    ├── vault/               # Obsidian notes
    ├── skills/              # Installed skills
    ├── channels/            # Installed channels
    ├── .ssh/                # Git SSH keys
    └── model-config.json    # Runtime model config
```

### Project Structure
```
~/jonas/                     # Git repository
├── .env                     # Environment variables
├── docker-compose.yml       # Container orchestration
├── apps/                    # Dashboard application
├── services/                # Agent, gateway services
├── packages/                # Shared libraries
└── .volumes/                # Volume mounts (local dev)
    └── agent-data/
```

## Environment Variables

### Required
```bash
# Claude API
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...

# Vector embeddings
VOYAGE_API_KEY=pa-...

# Security tokens
DASHBOARD_TOKEN=<secure-random-token>
GATEWAY_TOKEN=<secure-random-token>

# Matrix (if using)
MATRIX_BOT_PASSWORD=<password>
```

### Optional
```bash
# Model provider (default: claude)
MODEL_PROVIDER=claude|ollama

# Ports (defaults shown)
AGENT_PORT=3001
DASHBOARD_PORT=3000
GATEWAY_PORT=18789

# Domain (for production)
DOMAIN=your-domain.com
```

## Security Requirements

### SSH Configuration
```bash
# /etc/ssh/sshd_config
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
```

### File Permissions
```bash
# Environment file
chmod 600 .env

# SSH keys
chmod 600 /data/.ssh/*
chmod 644 /data/.ssh/*.pub
```

### Secrets Management
- ✅ Store secrets in `.env` (never commit)
- ✅ Use SSH keys for git operations
- ✅ Rotate tokens quarterly
- ✅ Use strong passwords (>20 chars)
- ❌ Never hardcode secrets in code
- ❌ Never expose .env to web server

### TLS/SSL (Production)
```bash
# Using Certbot + nginx
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

## Resource Monitoring

### Check Resource Usage
```bash
# Memory
docker stats

# Disk
df -h
du -sh /var/lib/docker/volumes/jonas_*

# Logs
docker compose logs -f --tail=100
```

### Log Rotation
```bash
# /etc/docker/daemon.json
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  }
}
```

## Backup Strategy

### Critical Data
1. **Database** - `/data/conversations.db`, `/data/audit.db`
2. **Vault** - `/data/vault/`
3. **Skills** - `/data/skills/`
4. **Config** - `.env`, `docker-compose.yml`

### Backup Script
```bash
#!/bin/bash
# backup-jonas.sh
DATE=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR="/backups/jonas-$DATE"

mkdir -p "$BACKUP_DIR"

# Stop agent for consistent backup
docker compose stop agent

# Backup data
docker cp jonas-agent:/data "$BACKUP_DIR/"

# Backup configs
cp .env docker-compose.yml "$BACKUP_DIR/"

# Restart agent
docker compose start agent

# Compress
tar -czf "$BACKUP_DIR.tar.gz" "$BACKUP_DIR"
rm -rf "$BACKUP_DIR"

echo "Backup saved: $BACKUP_DIR.tar.gz"
```

### Restore Process
```bash
# Extract backup
tar -xzf backup.tar.gz

# Stop containers
docker compose down

# Restore data
docker cp backup/data/. jonas-agent:/data/

# Start containers
docker compose up -d
```

## Performance Tuning

### For Low-Resource Systems (4GB RAM)
```yaml
# docker-compose.yml
services:
  agent:
    mem_limit: 2g
  qdrant:
    mem_limit: 1g
```

### For High-Volume Systems (8GB+ RAM)
```bash
# Increase ulimits
ulimit -n 65536

# Docker daemon
# /etc/docker/daemon.json
{
  "default-ulimits": {
    "nofile": {
      "Name": "nofile",
      "Hard": 65536,
      "Soft": 65536
    }
  }
}
```

## Troubleshooting

### Container Won't Start
```bash
# Check logs
docker compose logs agent

# Check resources
docker stats
free -h
df -h

# Restart services
docker compose restart
```

### Database Locked
```bash
# Check for stale locks
docker exec jonas-agent ls -la /data/*.db-wal

# Force unlock (use with caution)
docker exec jonas-agent rm /data/*.db-wal
docker compose restart agent
```

### Network Issues
```bash
# Test connectivity
curl -I https://api.anthropic.com
ping -c 3 api.anthropic.com

# DNS resolution
nslookup api.anthropic.com

# Docker network
docker network inspect jonas_default
```

### High Memory Usage
```bash
# Check Qdrant
docker exec jonas-qdrant du -sh /qdrant/storage

# Check conversations
docker exec jonas-agent sqlite3 /data/conversations.db "SELECT COUNT(*) FROM messages"

# Prune old data
docker system prune -a
```

## Upgrade Path

### Minor Updates
```bash
cd ~/jonas
git pull
pnpm install
pnpm build
docker compose up -d --build
```

### Major Updates
1. Backup data
2. Review CHANGELOG
3. Update .env if needed
4. Build and test locally
5. Deploy to production
6. Verify all services

## Support & Resources

- **Repository**: https://github.com/your-org/jonas
- **Documentation**: `.claude/docs/`
- **Issues**: GitHub Issues
- **Logs**: `docker compose logs -f`

## Tested Platforms

- ✅ Ubuntu 24.04 LTS (Recommended)
- ✅ Ubuntu 22.04 LTS
- ✅ Debian 12
- ⚠️  Ubuntu 20.04 (Docker version may be too old)
- ❌ CentOS/RHEL (Not tested)
- ❌ Windows (Use WSL2 + Docker Desktop)
- ❌ macOS (Development only, not for production)
