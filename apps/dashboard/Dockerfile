FROM node:22-slim AS base
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /app

# Install and build
FROM base AS build
COPY pnpm-workspace.yaml pnpm-lock.yaml* package.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/config/package.json ./packages/config/
COPY apps/dashboard/package.json ./apps/dashboard/
RUN pnpm install --frozen-lockfile 2>/dev/null || pnpm install
COPY packages/config/ ./packages/config/
COPY packages/shared/ ./packages/shared/
COPY apps/dashboard/ ./apps/dashboard/
RUN pnpm --filter @jonas/shared build && pnpm --filter @jonas/dashboard build

# Production deps
FROM base AS prod-deps
COPY pnpm-workspace.yaml pnpm-lock.yaml* package.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/config/package.json ./packages/config/
COPY apps/dashboard/package.json ./apps/dashboard/
RUN pnpm install --prod --frozen-lockfile 2>/dev/null || pnpm install --prod

# Runtime
FROM node:22-slim AS runtime
RUN groupadd -g 1001 jonas && useradd -u 1001 -g jonas -m jonas
WORKDIR /app

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=prod-deps /app/apps/dashboard/node_modules ./apps/dashboard/node_modules
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/
COPY --from=build /app/apps/dashboard/dist ./apps/dashboard/dist
COPY --from=build /app/apps/dashboard/package.json ./apps/dashboard/
COPY --from=build /app/package.json ./
COPY --from=build /app/pnpm-workspace.yaml ./

USER jonas
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r=>{process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"

CMD ["node", "apps/dashboard/dist/index.js"]
