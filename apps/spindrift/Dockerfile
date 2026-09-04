# syntax=docker/dockerfile:1
#
# One image, two process entrypoints (§19): `web` is the image default and the
# installer selects `reconciler` with its own command.
#
# The client is built here and **served as files at runtime**, which is what
# keeps the compile-time toolchain out of the running container. The server
# entry (`src/web/server.ts`) imports no HTML module, so Tailwind, the bundler,
# and TypeScript's toolchain are all build-stage only; `bun install
# --production` in the `deps` stage is what actually drops them, and
# `test/web/routes.test.ts` is what stops an import from quietly putting one
# back.
#
# `src/web/dev.ts` is the other entry and does the opposite — Bun's HTML import,
# compiled on demand, so `bun run dev` needs no build step. That convenience is
# the thing production is not paying for.
FROM cgr.dev/chainguard/node:latest-dev@sha256:585ddbb27d9250036a4248b5cd2ad76923ccfc66fa5d98fb37abdead3f09bf3d AS base
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

# The runtime's dependencies alone, resolved from the same lockfile so the two
# stages cannot disagree about a version.
FROM base AS deps
WORKDIR /app
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/bun.lock ./bun.lock
RUN bun install --frozen-lockfile --production

# First-party artifact verifier (§35). Replaces upstream release binaries (cosign & slsa-verifier).
FROM ghcr.io/jonpulsifer/spindrift-verifier:latest@sha256:24c2f0b03652fa515dd6a9c94c92abc4c83f61b8af22a1257fed96dccef0a2dc AS supply-chain-tools

FROM cgr.dev/chainguard/node:latest@sha256:716088322be7b5d08a5ae97d8d534f0d743ec06e16dc33ae170b015422262bd8 AS runner
ENV NODE_ENV=production \
  PORT=3000
WORKDIR /app
# The chart runs this as uid 65532 with a read-only root filesystem, so
# everything is copied world-readable rather than owned by a build user.
COPY --from=deps --chmod=755 /app ./
COPY --from=builder --chmod=755 /app/apps/spindrift/src ./apps/spindrift/src
COPY --from=builder --chmod=755 /app/apps/spindrift/dist ./apps/spindrift/dist
# `deps` carries each workspace's package.json and the symlink to it, never its
# source — and the server imports `@repo/archive`'s modules at run time. From
# `pruner` rather than `builder` because that tree has had no install run in it,
# so no `node_modules` rides along.
COPY --from=pruner --chmod=755 /app/out/full/packages/archive ./packages/archive
COPY --from=base /usr/local/bin/bun /usr/local/bin/bun
COPY --from=supply-chain-tools /spindrift-verifier /usr/local/bin/spindrift-verifier
# Fail the image build at the packaging seam rather than shipping a chart
# command whose module the runtime image does not contain. The workspace
# packages are asserted through the symlinks `deps` left behind, because that is
# how the server resolves them and a bare `packages/<name>` check would pass
# without one.
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
