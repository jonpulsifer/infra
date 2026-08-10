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
FROM cgr.dev/chainguard/node:latest-dev@sha256:1bd1aa2a03ffd28fff8f99f1330bbf3080e03d5c76e4758572a403dd71baa9e8 AS base
ARG BUN_VERSION=1.3.14
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
FROM ghcr.io/jonpulsifer/spindrift-verifier:latest@sha256:e0e8bfd252f4e3551f706a2ca3b65b94fd32c5bd3858cec2cfc868d03a2740a6 AS supply-chain-tools

FROM cgr.dev/chainguard/node:latest@sha256:8e1189525a80564e0df5cec59bc4aa5d859869e6e7c05b0a4290682fbd53563e AS runner
ENV NODE_ENV=production \
  PORT=3000
WORKDIR /app
# The chart runs this as uid 65532 with a read-only root filesystem, so
# everything is copied world-readable rather than owned by a build user.
COPY --from=deps --chmod=755 /app ./
COPY --from=builder --chmod=755 /app/apps/spindrift/src ./apps/spindrift/src
COPY --from=builder --chmod=755 /app/apps/spindrift/dist ./apps/spindrift/dist
COPY --from=base /usr/local/bin/bun /usr/local/bin/bun
COPY --from=supply-chain-tools /spindrift-verifier /usr/local/bin/spindrift-verifier
# Fail the image build at the packaging seam rather than shipping a chart
# command whose module the runtime image does not contain.
RUN test -f /app/apps/spindrift/src/web/server.ts \
  && test -f /app/apps/spindrift/src/reconciler/main.ts \
  && test -f /app/apps/spindrift/src/db/migrate.ts \
  && test -f /app/apps/spindrift/src/db/wait-for-schema.ts \
  && test -f /app/apps/spindrift/src/db/migrations/meta/_journal.json
WORKDIR /app/apps/spindrift
USER 65532:65532
EXPOSE 3000
ENTRYPOINT []
CMD ["/usr/local/bin/bun", "run", "src/web/server.ts"]
