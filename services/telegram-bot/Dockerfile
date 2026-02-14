FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@latest --activate

FROM base AS builder
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY package.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/config/package.json ./packages/config/
COPY services/telegram-bot/package.json ./services/telegram-bot/
RUN pnpm install --frozen-lockfile

COPY packages/ ./packages/
COPY services/telegram-bot/ ./services/telegram-bot/
RUN pnpm --filter @jonas/shared build && pnpm --filter @jonas/telegram-bot build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY package.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/config/package.json ./packages/config/
COPY services/telegram-bot/package.json ./services/telegram-bot/
RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/services/telegram-bot/dist ./services/telegram-bot/dist

WORKDIR /app/services/telegram-bot
CMD ["node", "dist/index.js"]
