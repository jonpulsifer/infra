# syntax=docker/dockerfile:1
#
# switchboard: one Bun process that runs its source as committed, with no build step.
FROM cgr.dev/chainguard/node:latest-dev@sha256:d0db506a46ecf9fca69413576d9621988d1e879956e8f9241c87d7fb5a200a68 AS base
# renovate: datasource=npm depName=bun
ARG BUN_VERSION=1.4.4
ENV BUN_INSTALL=/usr/local \
  TURBO_TELEMETRY_DISABLED=1
USER root
RUN apk add --no-cache bash curl unzip \
  && curl -fsSL https://bun.sh/install | bash -s -- "bun-v${BUN_VERSION}"

FROM base AS pruner
# renovate: datasource=npm depName=turbo
ARG TURBO_VERSION=2.11.10
WORKDIR /app
COPY . .
RUN bun x "turbo@${TURBO_VERSION}" prune switchboard --docker

FROM base AS deps
WORKDIR /app
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/bun.lock ./bun.lock
RUN bun install --frozen-lockfile --production

FROM cgr.dev/chainguard/node:latest@sha256:4ad7301975908b87d321af8b9ed41630dc69015976269965ee459c27541df252 AS runner
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
