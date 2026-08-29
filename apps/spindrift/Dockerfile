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
FROM cgr.dev/chainguard/node:latest-dev@sha256:4cd2bedce5955f933c8dca76df9bdff301505f3d0994c1e7e829a01e1718e650 AS base
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
FROM ghcr.io/jonpulsifer/spindrift-verifier:latest@sha256:09c7e6125342240a778c4e61ca8bc81fb9a954bab0344629fafdaaa35047ea13 AS supply-chain-tools

FROM cgr.dev/chainguard/node:latest@sha256:a422ef283675c760d801378646f2a7fdc96f4e2023121a247e215ed3cd39f199 AS runner
ENV NODE_ENV=production \
  PORT=3000
WORKDIR /app
# The chart runs this as uid 65532 with a read-only root filesystem, so
# everything is copied world-readable rather than owned by a build user.
COPY --from=deps --chmod=755 /app ./
COPY --from=builder --chmod=755 /app/apps/spindrift/src ./apps/spindrift/src
COPY --from=builder --chmod=755 /app/apps/spindrift/dist ./apps/spindrift/dist
# `deps` carries this workspace's package.json and the symlink to it, never its
# source, and the server reads `landing.html` and `sdk.js` off this directory.
# From `pruner` rather than `builder` because that tree has had no install run
# in it, so no `node_modules` rides along.
COPY --from=pruner --chmod=755 /app/out/full/packages/kthx ./packages/kthx
COPY --from=base /usr/local/bin/bun /usr/local/bin/bun
COPY --from=supply-chain-tools /spindrift-verifier /usr/local/bin/spindrift-verifier
# Fail the image build at the packaging seam rather than shipping a chart
# command whose module the runtime image does not contain. The kthx assets are
# asserted through the workspace symlink `deps` left behind, because that is
# how the server resolves them and a bare `packages/kthx` check would pass
# without it.
RUN test -f /app/apps/spindrift/src/web/server.ts \
  && test -f /app/apps/spindrift/src/reconciler/main.ts \
  && test -f /app/apps/spindrift/src/db/migrate.ts \
  && test -f /app/apps/spindrift/src/db/wait-for-schema.ts \
  && test -f /app/apps/spindrift/src/db/migrations/meta/_journal.json \
  && test -f /app/apps/spindrift/node_modules/@repo/kthx/landing.html
WORKDIR /app/apps/spindrift
USER 65532:65532
EXPOSE 3000
ENTRYPOINT []
CMD ["/usr/local/bin/bun", "run", "src/web/server.ts"]
