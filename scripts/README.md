# Scripts

Utility scripts for Jonas agent management.

## Vault Sync

**Note:** The vault sync script has been moved to the Obsidian project at:
`~/Projects/oc/scripts/sync-from-jonas.sh`

See `~/Projects/oc/README.md` for setup instructions.

## Legacy Vault Sync (Deprecated)

### Setup

1. **Configure environment variables** in `.env`:
   ```bash
   # Copy from template if needed
   cp env.example .env

   # Edit these variables:
   VAULT_SYNC_REMOTE_HOST=user@your-vm-hostname.com
   VAULT_SYNC_REMOTE_PATH=/path/to/jonas/.volumes/agent-data/vault/
   VAULT_SYNC_LOCAL_PATH=$HOME/Projects/oc
   VAULT_SYNC_SUBFOLDER=Jonas
   ```

2. **Set up SSH access** (if not already configured):
   ```bash
   # Test SSH connection
   ssh user@your-vm-hostname.com "ls /path/to/jonas/.volumes/agent-data/vault/"

   # Optional: Add to ~/.ssh/config for easier access
   cat >> ~/.ssh/config << 'EOF'
   Host jonas
       HostName your-vm-hostname.com
       User your-username
       IdentityFile ~/.ssh/id_ed25519
   EOF

   # Then you can use: VAULT_SYNC_REMOTE_HOST=jonas
   ```

3. **Add shell alias** to `~/.zshrc` or `~/.bashrc`:
   ```bash
   # Jonas vault sync
   alias jvs='~/Projects/jonas/scripts/sync-vault.sh'
   ```

4. **Reload shell**:
   ```bash
   source ~/.zshrc
   ```

### Usage

```bash
# Sync vault from agent to local Obsidian
jvs

# Or run directly
./scripts/sync-vault.sh
```

The script will:
1. Show what files will be synced (dry-run)
2. Ask for confirmation
3. Sync files to `~/Projects/oc/Jonas/`
4. Create/update an index note
5. Update sync timestamp

### Directory Structure

After first sync, your Obsidian vault will have:

```
~/Projects/oc/
├── (your existing notes)
├── Jonas.md                 # Index note (auto-created)
└── Jonas/                   # Agent-generated notes
    ├── README.md
    ├── daily/
    ├── conversations/
    ├── research/
    ├── inbox/
    └── templates/
```

### Continuous Sync

For automatic syncing, you can run in watch mode:

```bash
# Sync every 60 seconds (runs in foreground)
watch -n 60 jvs

# Or create a background job
while true; do
  ~/Projects/jonas/scripts/sync-vault.sh --quiet
  sleep 300  # Every 5 minutes
done &
```

### Troubleshooting

**Error: "VAULT_SYNC_REMOTE_HOST not set"**
- Make sure `.env` file exists and contains the required variables

**Error: "Permission denied (publickey)"**
- Set up SSH key authentication to the remote host
- Test with: `ssh user@your-vm-hostname.com`

**Error: "No such file or directory"**
- Check that `VAULT_SYNC_REMOTE_PATH` is correct
- Ensure the agent has created `/data/vault/` directory

**Files not appearing in Obsidian**
- Check that Obsidian vault is pointed to `VAULT_SYNC_LOCAL_PATH`
- Verify files are in `~/Projects/oc/Jonas/` after sync
- Restart Obsidian if needed
