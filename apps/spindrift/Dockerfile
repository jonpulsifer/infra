# syntax=docker/dockerfile:1
#
# One image (§19). Today it starts one process — `web`; `reconciler` is the
# second entrypoint off this same image and arrives with the deploy loop.
#
# The server is run **from source** rather than from a pre-built bundle, and
# that is a deliberate trade for a named cost. `src/web/server.ts` reaches the
# client through Bun's HTML import, so `Bun.serve` bundles the React app at
# boot — which means the runtime needs the toolchain that compiles it, and
# `bun-plugin-tailwind` (declared in `bunfig.toml`) is a devDependency. So this
# image ships devDependencies and is larger than a runtime-only image would be.
#
# What that buys is one code path: the bundle a developer sees under `bun run
# dev` is the bundle production serves, compiled by the same plugin from the
# same stylesheet, with no second static-file route on a server whose route
# table is deliberately closed (`src/web/routes.ts`). `bun run build` still runs
# below, as a build-time gate — if the client does not compile, the image does
# not get published.
FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS base
ARG BUN_VERSION=1.3.14
ENV BUN_INSTALL=/usr/local \
  TURBO_TELEMETRY_DISABLED=1
RUN apk add --no-cache bash curl libc6-compat \
  && curl -fsSL https://bun.sh/install | bash -s -- "bun-v${BUN_VERSION}"

FROM base AS pruner
WORKDIR /app
COPY . .
RUN bun x turbo@2.10.3 prune spindrift --docker

FROM base AS builder
WORKDIR /app
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/bun.lock ./bun.lock
RUN bun install --frozen-lockfile
COPY --from=pruner /app/out/full/ .
# A gate, not an artifact: the server re-bundles at boot, but a client that
# does not compile must not become a published image.
RUN bun run build --filter=spindrift

FROM base AS runner
ENV NODE_ENV=production \
  PORT=3000
WORKDIR /app
# The chart runs this as uid 65532 with a read-only root filesystem, so
# everything is copied world-readable rather than owned by a build user.
COPY --from=builder --chmod=755 /app/node_modules ./node_modules
COPY --from=builder --chmod=755 /app/apps/spindrift ./apps/spindrift
COPY --from=builder --chmod=644 /app/package.json ./package.json
WORKDIR /app/apps/spindrift
USER 65532:65532
EXPOSE 3000
CMD ["bun", "run", "src/web/server.ts"]
