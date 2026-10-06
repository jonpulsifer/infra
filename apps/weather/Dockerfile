# syntax=docker/dockerfile:1
#
# weather: one Bun process that runs its source as committed, with no build step.
FROM cgr.dev/chainguard/node:latest-dev@sha256:9cc1ea0327a4658a0bee134864055768b0a06ffb8ef27ae4bb1a6254226ebda2 AS base
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

FROM cgr.dev/chainguard/node:latest@sha256:890c242118f6624fde2cdf8d8b03808e6f46c09eda8cf6a1c963a7abcbd8e9f0 AS runner
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
