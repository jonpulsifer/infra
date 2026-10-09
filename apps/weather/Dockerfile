# syntax=docker/dockerfile:1
#
# weather: one Bun process that runs its source as committed, with no build step.
FROM cgr.dev/chainguard/node:latest-dev@sha256:50d16ee9c3ca08af8a037220d0ee5b3ec95a941e1b1e7bdfccb723020b9ccc67 AS base
ARG BUN_VERSION=1.4.0
ENV BUN_INSTALL=/usr/local \
  TURBO_TELEMETRY_DISABLED=1
USER root
RUN apk add --no-cache bash curl unzip \
  && curl -fsSL https://bun.sh/install | bash -s -- "bun-v${BUN_VERSION}"

FROM base AS pruner
WORKDIR /app
COPY . .
RUN bun x turbo@2.11.5 prune weather --docker

FROM base AS deps
WORKDIR /app
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/bun.lock ./bun.lock
RUN bun install --frozen-lockfile --production

FROM cgr.dev/chainguard/node:latest@sha256:826c88f4b76281038fb6611d3b8ef736511188bc2fcdeeb369c7e05a58eb697c AS runner
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
