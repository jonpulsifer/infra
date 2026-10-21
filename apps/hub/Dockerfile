# syntax=docker/dockerfile:1
FROM node:24-alpine@sha256:6a1c190e17215d844926b0677f4bf87273ff7d5e54db06d3b5b5863ab0b09a3d AS base
# renovate: datasource=npm depName=bun
ARG BUN_VERSION=1.4.3
ENV BUN_INSTALL=/usr/local \
  TURBO_TELEMETRY_DISABLED=1
RUN apk add --no-cache bash curl libc6-compat \
  && curl -fsSL https://bun.sh/install | bash -s -- "bun-v${BUN_VERSION}"

FROM base AS pruner
# renovate: datasource=npm depName=turbo
ARG TURBO_VERSION=2.11.7
WORKDIR /app
COPY . .
RUN bun x "turbo@${TURBO_VERSION}" prune hub --docker

FROM base AS builder
WORKDIR /app
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/bun.lock ./bun.lock
RUN bun install --frozen-lockfile
COPY --from=pruner /app/out/full/ .
# The build ID hashes the pruned inputs, not the clock, so a rebuild of unchanged sources reloads no kiosk.
# Bun's filter runs hub's script without turbo, whose strict env mode would drop GIT_SHA.
RUN GIT_SHA="$(find . -name node_modules -prune -o -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-16)" \
  bun run --filter=hub build

FROM base AS runner
ENV NODE_ENV=production
WORKDIR /app
USER 1000:1000
COPY --from=builder --chown=1000:1000 /app/node_modules ./node_modules
COPY --from=builder --chown=1000:1000 /app/apps/hub/node_modules ./apps/hub/node_modules
COPY --from=builder --chown=1000:1000 /app/apps/hub/package.json ./apps/hub/package.json
COPY --from=builder --chown=1000:1000 /app/apps/hub/build ./apps/hub/build
WORKDIR /app/apps/hub
EXPOSE 3000
CMD ["bun", "run", "start"]
