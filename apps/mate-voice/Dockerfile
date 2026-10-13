# syntax=docker/dockerfile:1
#
# mate-voice: the bridge that holds mate's Discord voice connection. One Bun
# process running its source as committed, with no build step. The smoke run
# in the runner proves the DAVE and Opus pieces load where they will run.
FROM cgr.dev/chainguard/node:latest-dev@sha256:f3ff59f82002e261f6ccc1eb3e876df19666502a0e16b7f535690e1d26895ae9 AS base
# renovate: datasource=npm depName=bun
ARG BUN_VERSION=1.4.2
ENV BUN_INSTALL=/usr/local \
  TURBO_TELEMETRY_DISABLED=1
USER root
RUN apk add --no-cache bash curl unzip \
  && curl -fsSL https://bun.sh/install | bash -s -- "bun-v${BUN_VERSION}"

FROM base AS pruner
# renovate: datasource=npm depName=turbo
ARG TURBO_VERSION=2.11.7
WORKDIR /app
COPY . .
RUN bun x "turbo@${TURBO_VERSION}" prune mate-voice --docker

FROM base AS deps
WORKDIR /app
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/bun.lock ./bun.lock
RUN bun install --frozen-lockfile --production

FROM cgr.dev/chainguard/node:latest@sha256:51042bb0c3f282bc5694e8c9b3a06847ef847d566115f91dee6ad2cd88a7d26e AS runner
ENV NODE_ENV=production \
  MATE_VOICE_PORT=8080
WORKDIR /app
COPY --from=deps --chmod=755 /app ./
COPY --from=pruner --chmod=755 /app/out/full/apps/mate-voice/src ./apps/mate-voice/src
COPY --from=base /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app/apps/mate-voice
# The davey binary is native and opusscript is WASM: both must load in this
# image, on this Bun, or the bridge joins a channel it can neither hear nor
# speak in.
RUN test -f src/main.ts \
  && test -d node_modules/@discordjs/voice \
  && test -d node_modules/@snazzah/davey \
  && /usr/local/bin/bun run src/smoke.ts
USER 65532:65532
EXPOSE 8080
ENTRYPOINT []
CMD ["/usr/local/bin/bun", "run", "src/main.ts"]
