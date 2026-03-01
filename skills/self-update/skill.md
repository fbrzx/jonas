---
name: Self Update
description: Allows Jonas to update itself by pulling latest code from GitHub and rebuilding via Docker Compose
version: 1.1.0
author: fabfab
---

## Self Update Skill

This skill allows Jonas to update itself by pulling the latest code from GitHub and running `make rebuild`.

### When to use

Use this skill when the operator asks Jonas to:
- Update itself
- Pull latest changes from GitHub
- Rebuild and redeploy
- Apply new code changes

### How it works

1. Runs `git pull` in `/host/jonas` (the host repo, mounted into the container)
2. Runs `make rebuild` which rebuilds and restarts the Docker Compose stack via the mounted Docker socket
3. **Note:** Jonas will restart mid-way through — this is expected behaviour. The operator will need to reconnect after ~30-60 seconds.

### Important

Always warn the operator that Jonas will go offline briefly during the rebuild. The update runs in a background process so the response can be sent before the restart happens.

### Requirements

The agent container must have:
- `/host/jonas` — host repo mounted read-write (`/home/fbrz/jonas:/host/jonas`)
- `/var/run/docker.sock` — Docker socket mounted (`/var/run/docker.sock:/var/run/docker.sock`)

These are configured in `docker-compose.yml`.
