# syntax=docker/dockerfile:1
# The kthx server and the CLI tarball it serves. The server runs from source.
# The chart runs it as uid 65532 on a read-only root; `/tmp` and the sites
# volume are writable.
FROM cgr.dev/chainguard/node:latest-dev@sha256:c422a5418cd79766a6373a30635200fc7afe662baada54eee12a31b5a7b6f027 AS base
ARG BUN_VERSION=1.4.0
ENV BUN_INSTALL=/usr/local \
  TURBO_TELEMETRY_DISABLED=1
USER root
RUN apk add --no-cache bash curl unzip \
  && curl -fsSL https://bun.sh/install | bash -s -- "bun-v${BUN_VERSION}"

FROM base AS pruner
WORKDIR /app
COPY . .
RUN bun x turbo@2.10.3 prune kthx --docker

# Runtime dependencies only, from the repo lockfile.
FROM base AS deps
WORKDIR /app
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/bun.lock ./bun.lock
RUN bun install --frozen-lockfile --production

# The CLI is packed in the same image, so it matches the server that serves it.
# It imports `@repo/kthx` and never `@repo/archive`.
FROM deps AS cli
WORKDIR /app
COPY --from=pruner /app/out/full/apps/kthx ./apps/kthx
COPY --from=pruner /app/out/full/packages/kthx ./packages/kthx
RUN cd /app/apps/kthx && bun run pack

FROM cgr.dev/chainguard/node:latest@sha256:5d6d6287abf176121b173a0337a888900f2909f0ac06e4e096138be4898a8f92 AS runner
ENV NODE_ENV=production \
  PORT=8080 \
  KTHX_SITES_DIR=/sites
WORKDIR /app
# World-readable: the runtime uid owns nothing in the image.
COPY --from=deps --chmod=755 /app ./
COPY --from=pruner --chmod=755 /app/out/full/apps/kthx/server ./apps/kthx/server
COPY --from=pruner --chmod=755 /app/out/full/apps/kthx/cli ./apps/kthx/cli
# `deps` has only the workspace manifests and symlinks. `pruner` supplies the
# sources without a `node_modules`.
COPY --from=pruner --chmod=755 /app/out/full/packages/archive ./packages/archive
COPY --from=pruner --chmod=755 /app/out/full/packages/kthx ./packages/kthx
COPY --from=cli --chmod=755 /app/apps/kthx/dist/kthx.tgz ./apps/kthx/dist/kthx.tgz
# The same file is in the tarball, so `x-kthx-build` and the installed CLI agree.
COPY --from=cli --chmod=755 /app/apps/kthx/dist/version.json ./apps/kthx/dist/version.json
COPY --from=base /usr/local/bin/bun /usr/local/bin/bun
# Workspace packages are checked through the `node_modules` symlinks, the path
# the server resolves them by.
RUN test -f /app/apps/kthx/server/index.ts \
  && test -f /app/apps/kthx/server/migrations/0001_sites_and_releases.sql \
  && test -f /app/apps/kthx/node_modules/@repo/kthx/landing.html \
  && test -f /app/apps/kthx/node_modules/@repo/kthx/skill.md \
  && test -f /app/apps/kthx/node_modules/@repo/archive/archive-format.ts \
  && test -s /app/apps/kthx/dist/kthx.tgz \
  && test -s /app/apps/kthx/dist/version.json
WORKDIR /app/apps/kthx
USER 65532:65532
EXPOSE 8080
ENTRYPOINT []
CMD ["/usr/local/bin/bun", "run", "server/index.ts"]
