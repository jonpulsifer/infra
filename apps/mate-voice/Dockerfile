# syntax=docker/dockerfile:1
#
# mate-voice: the bridge that holds mate's Discord voice connection. One Bun
# process running its source as committed, with no build step. The smoke run
# in the runner proves the DAVE and Opus pieces load where they will run.
FROM cgr.dev/chainguard/node:latest-dev@sha256:17861bca64b10f95f6b39ac65908acd36e40988e75d4ec2421d1e1e9a646fb74 AS base
# renovate: datasource=npm depName=bun
ARG BUN_VERSION=1.4.3
ENV BUN_INSTALL=/usr/local \
  TURBO_TELEMETRY_DISABLED=1
USER root
RUN apk add --no-cache bash curl unzip \
  && curl -fsSL https://bun.sh/install | bash -s -- "bun-v${BUN_VERSION}"

FROM base AS pruner
# renovate: datasource=npm depName=turbo
ARG TURBO_VERSION=2.11.9
WORKDIR /app
COPY . .
RUN bun x "turbo@${TURBO_VERSION}" prune mate-voice --docker

FROM base AS deps
WORKDIR /app
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/bun.lock ./bun.lock
RUN bun install --frozen-lockfile --production

FROM cgr.dev/chainguard/node:latest@sha256:ffcc470ef9b6d2715eed2fe84cb342e11b9e438e37aa800ca5e2c5013d8d8b0b AS runner
ENV NODE_ENV=production \
  MATE_VOICE_PORT=8080
WORKDIR /app
COPY --from=deps --chmod=755 /app ./
COPY --from=pruner --chmod=755 /app/out/full/apps/mate-voice/src ./apps/mate-voice/src
# `deps` has only the workspace manifests and symlinks, so the package's
# source comes from `pruner`.
COPY --from=pruner --chmod=755 /app/out/full/packages/mate-voice-protocol/src ./packages/mate-voice-protocol/src
COPY --from=base /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app/apps/mate-voice
# The davey binary is native and opusscript is WASM: both must load in this
# image, on this Bun, or the bridge joins a channel it can neither hear nor
# speak in.
RUN test -f src/main.ts \
  && test -d node_modules/@discordjs/voice \
  && test -d node_modules/@snazzah/davey \
  && test -f node_modules/@repo/mate-voice-protocol/src/index.ts \
  && /usr/local/bin/bun run src/smoke.ts
USER 65532:65532
EXPOSE 8080
ENTRYPOINT []
CMD ["/usr/local/bin/bun", "run", "src/main.ts"]
