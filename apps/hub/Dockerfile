# syntax=docker/dockerfile:1
FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS base
ARG BUN_VERSION=1.3.10
RUN apk add --no-cache bash curl libc6-compat \
  && curl -fsSL https://bun.sh/install | bash -s -- "bun-v${BUN_VERSION}"
ENV PATH="/root/.bun/bin:${PATH}" \
  TURBO_TELEMETRY_DISABLED=1

FROM base AS pruner
WORKDIR /app
COPY . .
RUN bun x turbo@2.10.3 prune hub --docker

FROM base AS builder
WORKDIR /app
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/bun.lock ./bun.lock
RUN bun install --frozen-lockfile
COPY --from=pruner /app/out/full/ .
RUN bun run build --filter=hub

FROM base AS runner
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/hub/node_modules ./apps/hub/node_modules
COPY --from=builder /app/apps/hub/package.json ./apps/hub/package.json
COPY --from=builder /app/apps/hub/build ./apps/hub/build
WORKDIR /app/apps/hub
EXPOSE 3000
CMD ["bun", "run", "start"]
