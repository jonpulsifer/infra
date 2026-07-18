# syntax=docker/dockerfile:1
FROM node:24-alpine@sha256:156b55f92e98ccd5ef49578a8cea0df4679826564bad1c9d4ef04462b9f0ded6 AS base
ARG BUN_VERSION=1.3.10
RUN apk add --no-cache bash curl libc6-compat \
  && curl -fsSL https://bun.sh/install | bash -s -- --version "${BUN_VERSION}"
ENV PATH="/root/.bun/bin:${PATH}" \
  TURBO_TELEMETRY_DISABLED=1

FROM base AS pruner
WORKDIR /app
COPY . .
RUN bunx turbo@2.10.3 prune hub --docker

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
