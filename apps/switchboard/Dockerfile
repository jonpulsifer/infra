# syntax=docker/dockerfile:1
#
# switchboard: one Bun process that runs its source as committed, with no build step.
FROM cgr.dev/chainguard/node:latest-dev@sha256:d181b32cf4c1d4e23c6cbed1736f0b254933acb0a616fd63aedf883d7c2839e5 AS base
ARG BUN_VERSION=1.4.0
ENV BUN_INSTALL=/usr/local \
  TURBO_TELEMETRY_DISABLED=1
USER root
RUN apk add --no-cache bash curl unzip \
  && curl -fsSL https://bun.sh/install | bash -s -- "bun-v${BUN_VERSION}"

FROM base AS pruner
WORKDIR /app
COPY . .
RUN bun x turbo@2.10.3 prune switchboard --docker

FROM base AS deps
WORKDIR /app
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/bun.lock ./bun.lock
RUN bun install --frozen-lockfile --production

FROM cgr.dev/chainguard/node:latest@sha256:5d6d6287abf176121b173a0337a888900f2909f0ac06e4e096138be4898a8f92 AS runner
ENV NODE_ENV=production \
  SWITCHBOARD_PORT=8080
WORKDIR /app
COPY --from=deps --chmod=755 /app ./
COPY --from=pruner --chmod=755 /app/out/full/apps/switchboard/src ./apps/switchboard/src
COPY --from=base /usr/local/bin/bun /usr/local/bin/bun
RUN test -f /app/apps/switchboard/src/main.ts \
  && test -d /app/apps/switchboard/node_modules/hono
WORKDIR /app/apps/switchboard
USER 65532:65532
EXPOSE 8080
ENTRYPOINT []
CMD ["/usr/local/bin/bun", "run", "src/main.ts"]
