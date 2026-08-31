# syntax=docker/dockerfile:1
#
# The kthx server. One process, no build step: the pages a site serves are
# uploaded rather than compiled, and the only assets in the image are the apex
# landing page, the SDK and the agent reference, which `@repo/kthx` carries as
# files. So there is no `builder` stage — `deps` resolves the runtime's
# dependencies from the same lockfile the repo uses, and the source is copied
# out of the pruned tree exactly as it is committed.
#
# The chart runs this with a read-only root filesystem, `/tmp` and the sites
# volume being the only writable paths, as uid 65532.
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
RUN bun x turbo@2.10.3 prune kthx --docker

# The runtime's dependencies alone, resolved from the repo's lockfile so the
# image and a checkout cannot disagree about a version.
FROM base AS deps
WORKDIR /app
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/bun.lock ./bun.lock
RUN bun install --frozen-lockfile --production

FROM cgr.dev/chainguard/node:latest@sha256:a422ef283675c760d801378646f2a7fdc96f4e2023121a247e215ed3cd39f199 AS runner
ENV NODE_ENV=production \
  PORT=8080 \
  KTHX_SITES_DIR=/sites
WORKDIR /app
# Copied world-readable rather than owned by a build user, because the chart
# runs this as a uid that owns nothing in the image.
COPY --from=deps --chmod=755 /app ./
COPY --from=pruner --chmod=755 /app/out/full/apps/kthx/server ./apps/kthx/server
COPY --from=pruner --chmod=755 /app/out/full/apps/kthx/cli ./apps/kthx/cli
# `deps` carries each workspace's package.json and the symlink to it, never its
# source — and the server imports `@repo/archive`'s modules and reads
# `landing.html`, `sdk.js` and `skill.md` off `@repo/kthx` at run time. From
# `pruner` rather than a build stage because that tree has had no install run in
# it, so no `node_modules` rides along.
COPY --from=pruner --chmod=755 /app/out/full/packages/archive ./packages/archive
COPY --from=pruner --chmod=755 /app/out/full/packages/kthx ./packages/kthx
COPY --from=base /usr/local/bin/bun /usr/local/bin/bun
# Fail the build at the packaging seam rather than shipping an image whose
# entrypoint or assets are not in it. The workspace packages are asserted
# through the symlinks `deps` left behind, because that is how the server
# resolves them and a bare `packages/<name>` check would pass without one.
RUN test -f /app/apps/kthx/server/index.ts \
  && test -f /app/apps/kthx/server/migrations/0001_sites_and_releases.sql \
  && test -f /app/apps/kthx/node_modules/@repo/kthx/landing.html \
  && test -f /app/apps/kthx/node_modules/@repo/kthx/skill.md \
  && test -f /app/apps/kthx/node_modules/@repo/archive/archive-format.ts
WORKDIR /app/apps/kthx
USER 65532:65532
EXPOSE 8080
ENTRYPOINT []
CMD ["/usr/local/bin/bun", "run", "server/index.ts"]
