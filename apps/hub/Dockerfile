# syntax=docker/dockerfile:1
FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS base
ARG BUN_VERSION=1.4.0
ENV BUN_INSTALL=/usr/local \
  TURBO_TELEMETRY_DISABLED=1
RUN apk add --no-cache bash curl libc6-compat \
  && curl -fsSL https://bun.sh/install | bash -s -- "bun-v${BUN_VERSION}"

FROM base AS pruner
WORKDIR /app
COPY . .
RUN bun x turbo@2.10.3 prune hub --docker

FROM base AS builder
WORKDIR /app
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/bun.lock ./bun.lock
RUN bun install --frozen-lockfile
COPY --from=pruner /app/out/full/ .
RUN bun run build --filter=hub

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
