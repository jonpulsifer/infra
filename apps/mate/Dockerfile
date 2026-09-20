# syntax=docker/dockerfile:1
#
# mate: one Bun process, no build step. `deps` resolves the runtime's
# dependencies from the repo's lockfile and the source is copied out of the
# pruned tree exactly as committed. Runs as uid 65532 with nothing writable
# but what the manifest mounts.
FROM cgr.dev/chainguard/node:latest-dev@sha256:3eb79c0858f6d4c565323e64ac2dc8f3f1e3a6e5e0097bbe379de4a96963312f AS base
ARG BUN_VERSION=1.4.0
ENV BUN_INSTALL=/usr/local \
  TURBO_TELEMETRY_DISABLED=1
USER root
RUN apk add --no-cache bash curl unzip \
  && curl -fsSL https://bun.sh/install | bash -s -- "bun-v${BUN_VERSION}"

FROM base AS pruner
WORKDIR /app
COPY . .
RUN bun x turbo@2.10.3 prune mate --docker

FROM base AS deps
WORKDIR /app
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/bun.lock ./bun.lock
RUN bun install --frozen-lockfile --production

FROM cgr.dev/chainguard/node:latest@sha256:1f903d44fc11a6f6e74447fc2c6a3c141f112217576be5d96c283210116b5d25 AS runner
ENV NODE_ENV=production \
  MATE_PORT=8080
WORKDIR /app
COPY --from=deps --chmod=755 /app ./
COPY --from=pruner --chmod=755 /app/out/full/apps/mate/src ./apps/mate/src
COPY --from=base /usr/local/bin/bun /usr/local/bin/bun
RUN test -f /app/apps/mate/src/main.ts \
  && test -d /app/apps/mate/node_modules/@discordjs/ws
WORKDIR /app/apps/mate
USER 65532:65532
EXPOSE 8080
ENTRYPOINT []
CMD ["/usr/local/bin/bun", "run", "src/main.ts"]
