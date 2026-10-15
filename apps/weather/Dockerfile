# syntax=docker/dockerfile:1
#
# weather: one Bun process that runs its source as committed, with no build step.
FROM cgr.dev/chainguard/node:latest-dev@sha256:e7076475a5978df4626e4fcf99b368c4a8c2741b39249105f42a8fb4579bcb65 AS base
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
RUN bun x "turbo@${TURBO_VERSION}" prune weather --docker

FROM base AS deps
WORKDIR /app
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/bun.lock ./bun.lock
RUN bun install --frozen-lockfile --production

FROM cgr.dev/chainguard/node:latest@sha256:f5b8ab65cbb411f9e1996f8c331c6d8df38291133f0c9b327a893646422237ad AS runner
ENV NODE_ENV=production \
  WEATHER_PORT=8080
WORKDIR /app
COPY --from=deps --chmod=755 /app ./
COPY --from=pruner --chmod=755 /app/out/full/apps/weather/src ./apps/weather/src
COPY --from=base /usr/local/bin/bun /usr/local/bin/bun
RUN test -f /app/apps/weather/src/main.ts \
  && test -d /app/apps/weather/node_modules/@modelcontextprotocol/sdk
WORKDIR /app/apps/weather
USER 65532:65532
EXPOSE 8080
ENTRYPOINT []
CMD ["/usr/local/bin/bun", "run", "src/main.ts"]
