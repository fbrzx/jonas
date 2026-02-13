#!/bin/bash
set -euo pipefail

JONAS_VM_HOST="${JONAS_VM_HOST:?Set JONAS_VM_HOST to your VM address}"
JONAS_VM_USER="${JONAS_VM_USER:-$USER}"
MOUNT_POINT="${HOME}/Jonas-Vault"

echo "=== Connecting to Jonas ==="

# SSH tunnel for dashboard
echo "Opening SSH tunnel for dashboard (localhost:3000)..."
ssh -f -N -L 3000:127.0.0.1:3000 "${JONAS_VM_USER}@${JONAS_VM_HOST}"

# SSHFS mount for vault
if command -v sshfs &>/dev/null; then
  mkdir -p "$MOUNT_POINT"
  if ! mountpoint -q "$MOUNT_POINT" 2>/dev/null; then
    echo "Mounting vault via SSHFS..."
    sshfs "${JONAS_VM_USER}@${JONAS_VM_HOST}:/var/lib/docker/volumes/jonas_vault_data/_data" \
      "$MOUNT_POINT" \
      -o reconnect,ServerAliveInterval=15,ServerAliveCountMax=3
    echo "Vault mounted at $MOUNT_POINT (open in Obsidian)"
  else
    echo "Vault already mounted at $MOUNT_POINT"
  fi
else
  echo "sshfs not installed — skipping vault mount"
  echo "Install: brew install macfuse sshfs (macOS) or apt install sshfs (Linux)"
fi

echo ""
echo "Dashboard: http://localhost:3000"
echo "Vault: $MOUNT_POINT"
