# syntax=docker/dockerfile:1
#
# weather: one Bun process that runs its source as committed, with no build step.
FROM cgr.dev/chainguard/node:latest-dev@sha256:754ab8996c0c25b90774d9a90bf62ffbbbf4ac766adc773512fbdc3874846fa4 AS base
ARG BUN_VERSION=1.4.0
ENV BUN_INSTALL=/usr/local \
  TURBO_TELEMETRY_DISABLED=1
USER root
RUN apk add --no-cache bash curl unzip \
  && curl -fsSL https://bun.sh/install | bash -s -- "bun-v${BUN_VERSION}"

FROM base AS pruner
WORKDIR /app
COPY . .
RUN bun x turbo@2.10.3 prune weather --docker

FROM base AS deps
WORKDIR /app
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/bun.lock ./bun.lock
RUN bun install --frozen-lockfile --production

FROM cgr.dev/chainguard/node:latest@sha256:af9d762479c010649ab93b6ba2b0580522956d30c15043b61b00dea5743c9096 AS runner
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
