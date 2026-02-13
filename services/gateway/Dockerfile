FROM node:22-slim AS base
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /app

# Install and build
FROM base AS build
COPY pnpm-workspace.yaml pnpm-lock.yaml* package.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/config/package.json ./packages/config/
COPY services/gateway/package.json ./services/gateway/
RUN pnpm install --frozen-lockfile 2>/dev/null || pnpm install
COPY packages/config/ ./packages/config/
COPY packages/shared/ ./packages/shared/
COPY services/gateway/ ./services/gateway/
RUN pnpm --filter @jonas/shared build && pnpm --filter @jonas/gateway build

# Production deps
FROM base AS prod-deps
COPY pnpm-workspace.yaml pnpm-lock.yaml* package.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/config/package.json ./packages/config/
COPY services/gateway/package.json ./services/gateway/
RUN pnpm install --prod --frozen-lockfile 2>/dev/null || pnpm install --prod

# Runtime
FROM node:22-slim AS runtime
RUN groupadd -g 1001 jonas && useradd -u 1001 -g jonas -m jonas
WORKDIR /app

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=prod-deps /app/services/gateway/node_modules ./services/gateway/node_modules
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/
COPY --from=build /app/services/gateway/dist ./services/gateway/dist
COPY --from=build /app/services/gateway/package.json ./services/gateway/
COPY --from=build /app/package.json ./
COPY --from=build /app/pnpm-workspace.yaml ./

USER jonas
EXPOSE 18789

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://localhost:18789/').then(r=>{process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"

CMD ["node", "services/gateway/dist/index.js"]
