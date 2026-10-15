# syntax=docker/dockerfile:1
FROM node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f AS base
# renovate: datasource=npm depName=bun
ARG BUN_VERSION=1.4.2
ENV BUN_INSTALL=/usr/local \
  TURBO_TELEMETRY_DISABLED=1
RUN apk add --no-cache bash curl libc6-compat \
  && curl -fsSL https://bun.sh/install | bash -s -- "bun-v${BUN_VERSION}"

FROM base AS pruner
# renovate: datasource=npm depName=turbo
ARG TURBO_VERSION=2.11.7
WORKDIR /app
COPY . .
RUN bun x "turbo@${TURBO_VERSION}" prune clankerbanker --docker

FROM base AS builder
WORKDIR /app
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/bun.lock ./bun.lock
RUN bun install --frozen-lockfile
COPY --from=pruner /app/out/full/ .

FROM base AS runner
ENV NODE_ENV=production
WORKDIR /app
USER 1000:1000
COPY --from=builder --chown=1000:1000 /app/node_modules ./node_modules
COPY --from=builder --chown=1000:1000 /app/apps/clankerbanker/node_modules ./apps/clankerbanker/node_modules
COPY --from=builder --chown=1000:1000 /app/apps/clankerbanker/package.json ./apps/clankerbanker/package.json
COPY --from=builder --chown=1000:1000 /app/apps/clankerbanker/src ./apps/clankerbanker/src
WORKDIR /app/apps/clankerbanker
EXPOSE 3000
CMD ["bun", "run", "src/server.ts"]
