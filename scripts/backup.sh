#!/bin/bash
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/opt/jonas/backups}"
DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_PATH="$BACKUP_DIR/$DATE"

echo "=== Jonas Backup — $DATE ==="
mkdir -p "$BACKUP_PATH"

# Qdrant snapshot
echo "Snapshotting Qdrant..."
for collection in memory_episodic memory_semantic memory_procedural; do
  curl -s -X POST "http://localhost:6333/collections/$collection/snapshots" | \
    jq -r '.result.name' | \
    xargs -I{} curl -s -o "$BACKUP_PATH/qdrant_${collection}_{}.snapshot" \
    "http://localhost:6333/collections/$collection/snapshots/{}"
done

# Vault
echo "Backing up vault..."
docker cp "$(docker compose ps -q agent)":/data/vault "$BACKUP_PATH/vault" 2>/dev/null || \
  cp -r /var/lib/docker/volumes/jonas_vault_data/_data "$BACKUP_PATH/vault"

# Custom skills
echo "Backing up custom skills..."
docker cp "$(docker compose ps -q agent)":/data/skills-custom "$BACKUP_PATH/skills-custom" 2>/dev/null || true

# Compress
echo "Compressing..."
tar -czf "$BACKUP_PATH.tar.gz" -C "$BACKUP_DIR" "$DATE"
rm -rf "$BACKUP_PATH"

# Retain last 7 days
find "$BACKUP_DIR" -name "*.tar.gz" -mtime +7 -delete

echo "=== Backup complete: $BACKUP_PATH.tar.gz ==="
