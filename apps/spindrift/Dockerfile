# syntax=docker/dockerfile:1
# One image, two processes: `web` is the default command and the chart starts
# `reconciler` with its own. The client ships as prebuilt files in dist/.
FROM cgr.dev/chainguard/node:latest-dev@sha256:ea7d0133c47e062b7754da987c05d4d1206e0a9e357a49679271d071f48e65e2 AS base
ARG BUN_VERSION=1.4.0
ENV BUN_INSTALL=/usr/local \
  TURBO_TELEMETRY_DISABLED=1
USER root
RUN apk add --no-cache bash curl unzip \
  && curl -fsSL https://bun.sh/install | bash -s -- "bun-v${BUN_VERSION}"

FROM base AS pruner
WORKDIR /app
COPY . .
RUN bun x turbo@2.10.3 prune spindrift --docker

# Everything, so the client can be compiled.
FROM base AS builder
WORKDIR /app
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/bun.lock ./bun.lock
RUN bun install --frozen-lockfile
COPY --from=pruner /app/out/full/ .
RUN bun run build --filter=spindrift

# Production dependencies only, so no bundler or Tailwind. src/web/server.ts must
# not import HTML; test/web/routes.test.ts enforces it.
FROM base AS deps
WORKDIR /app
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/bun.lock ./bun.lock
RUN bun install --frozen-lockfile --production

# First-party stand-in for the cosign and slsa-verifier CLIs.
FROM ghcr.io/jonpulsifer/spindrift-verifier:latest@sha256:9625e20c925c614a3f491661f5ccbda9bab254b52f70f3bcb56e8341262c3f31 AS supply-chain-tools

FROM cgr.dev/chainguard/node:latest@sha256:3d462c24088fa9189404fc19b837f6b39636671571491c9c5dd7b75e3e2df550 AS runner
ENV NODE_ENV=production \
  PORT=3000
WORKDIR /app
# The chart runs uid 65532 on a read-only root filesystem, so files are copied
# world-readable.
COPY --from=deps --chmod=755 /app ./
COPY --from=builder --chmod=755 /app/apps/spindrift/src ./apps/spindrift/src
COPY --from=builder --chmod=755 /app/apps/spindrift/dist ./apps/spindrift/dist
# `deps` has each workspace's package.json and symlink but no source, and the
# server imports archive source at run time. `pruner` has no node_modules to copy.
COPY --from=pruner --chmod=755 /app/out/full/packages/archive ./packages/archive
COPY --from=base /usr/local/bin/bun /usr/local/bin/bun
COPY --from=supply-chain-tools /spindrift-verifier /usr/local/bin/spindrift-verifier
# Fail the build when a chart command's module is missing. @repo/archive is
# checked through its node_modules symlink, the path the server resolves.
RUN test -f /app/apps/spindrift/src/web/server.ts \
  && test -f /app/apps/spindrift/src/reconciler/main.ts \
  && test -f /app/apps/spindrift/src/db/migrate.ts \
  && test -f /app/apps/spindrift/src/db/wait-for-schema.ts \
  && test -f /app/apps/spindrift/src/db/migrations/meta/_journal.json \
  && test -f /app/apps/spindrift/node_modules/@repo/archive/archive-format.ts
WORKDIR /app/apps/spindrift
USER 65532:65532
EXPOSE 3000
ENTRYPOINT []
CMD ["/usr/local/bin/bun", "run", "src/web/server.ts"]
