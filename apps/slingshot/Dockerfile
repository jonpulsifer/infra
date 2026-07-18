# syntax=docker/dockerfile:1
FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS base
ARG BUN_VERSION=1.3.10
RUN apk add --no-cache bash curl libc6-compat \
  && curl -fsSL https://bun.sh/install | bash -s -- "bun-v${BUN_VERSION}"
ENV PATH="/root/.bun/bin:${PATH}" \
  NEXT_TELEMETRY_DISABLED=1 \
  TURBO_TELEMETRY_DISABLED=1

FROM base AS pruner
WORKDIR /app
COPY . .
RUN bun x turbo@2.10.3 prune slingshot --docker

FROM base AS builder
ENV STANDALONE=1
WORKDIR /app
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/bun.lock ./bun.lock
RUN bun install --frozen-lockfile
COPY --from=pruner /app/out/full/ .
RUN bun run build --filter=slingshot

FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS runner
ENV HOSTNAME=0.0.0.0 \
  NODE_ENV=production \
  NEXT_TELEMETRY_DISABLED=1 \
  PORT=3000
WORKDIR /app
COPY --from=builder --chown=65532:65532 /app/apps/slingshot/.next/standalone ./
COPY --from=builder --chown=65532:65532 /app/apps/slingshot/.next/static ./apps/slingshot/.next/static
COPY --from=builder --chown=65532:65532 /app/apps/slingshot/public ./apps/slingshot/public
USER 65532:65532
EXPOSE 3000
CMD ["node", "apps/slingshot/server.js"]
