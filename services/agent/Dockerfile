FROM node:22-slim AS base
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /app

# Install all dependencies and build
FROM base AS build
COPY pnpm-workspace.yaml pnpm-lock.yaml* package.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/config/package.json ./packages/config/
COPY services/agent/package.json ./services/agent/
RUN pnpm install --frozen-lockfile 2>/dev/null || pnpm install
COPY packages/config/ ./packages/config/
COPY packages/shared/ ./packages/shared/
COPY services/agent/ ./services/agent/
RUN pnpm --filter @jonas/shared build && pnpm --filter @jonas/agent build

# Production dependencies only
FROM base AS prod-deps
COPY pnpm-workspace.yaml pnpm-lock.yaml* package.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/config/package.json ./packages/config/
COPY services/agent/package.json ./services/agent/
RUN pnpm install --prod --frozen-lockfile 2>/dev/null || pnpm install --prod

# Runtime
FROM node:22-slim AS runtime
RUN groupadd -g 1001 jonas && useradd -u 1001 -g jonas -m jonas
WORKDIR /app

# Copy production node_modules (preserves workspace symlinks)
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=prod-deps /app/services/agent/node_modules ./services/agent/node_modules

# Copy built output
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/
COPY --from=build /app/services/agent/dist ./services/agent/dist
COPY --from=build /app/services/agent/package.json ./services/agent/

# Copy workspace root package.json (needed for pnpm workspace resolution)
COPY --from=build /app/package.json ./
COPY --from=build /app/pnpm-workspace.yaml ./

# Create data directories owned by jonas
RUN mkdir -p /data/vault /data/skills-custom && chown -R jonas:jonas /data

# Install gosu + Python (for skill MCP tool servers)
RUN apt-get update && \
    apt-get install -y --no-install-recommends gosu python3 python3-pip python3-venv && \
    rm -rf /var/lib/apt/lists/*
RUN pip3 install --break-system-packages mcp

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://localhost:3001/api/status').then(r=>{process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"

# Start as root, fix volume ownership, then drop to jonas
CMD ["sh", "-c", "chown -R jonas:jonas /data && exec gosu jonas node services/agent/dist/index.js"]
