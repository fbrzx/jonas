#!/bin/bash
set -euo pipefail

echo "=== Jonas VM Setup ==="

# Install Docker if not present
if ! command -v docker &>/dev/null; then
  echo "Installing Docker..."
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker "$USER"
  echo "Docker installed. Log out and back in for group changes."
fi

# Install Docker Compose plugin if not present
if ! docker compose version &>/dev/null; then
  echo "Installing Docker Compose plugin..."
  sudo apt-get update && sudo apt-get install -y docker-compose-plugin
fi

# Create data directories
sudo mkdir -p /opt/jonas
sudo chown "$USER:$USER" /opt/jonas

# Copy project files
echo "Copy your project files to /opt/jonas/"
echo "Then run: cd /opt/jonas && cp .env.example .env && vim .env"
echo "Finally: docker compose up -d"

echo "=== Setup complete ==="
