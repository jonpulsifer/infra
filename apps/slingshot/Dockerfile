# syntax=docker/dockerfile:1
FROM node:26-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94 AS base
# renovate: datasource=npm depName=bun
ARG BUN_VERSION=1.4.3
RUN apk add --no-cache bash curl libc6-compat \
  && curl -fsSL https://bun.sh/install | bash -s -- "bun-v${BUN_VERSION}"
ENV PATH="/root/.bun/bin:${PATH}" \
  NEXT_TELEMETRY_DISABLED=1 \
  TURBO_TELEMETRY_DISABLED=1

FROM base AS pruner
# renovate: datasource=npm depName=turbo
ARG TURBO_VERSION=2.11.9
WORKDIR /app
COPY . .
RUN bun x "turbo@${TURBO_VERSION}" prune slingshot --docker

FROM base AS builder
ENV STANDALONE=1
WORKDIR /app
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/bun.lock ./bun.lock
RUN bun install --frozen-lockfile
COPY --from=pruner /app/out/full/ .
RUN --mount=type=secret,id=gcp_credentials,required=true \
  GOOGLE_APPLICATION_CREDENTIALS=/run/secrets/gcp_credentials \
  bun run build --filter=slingshot

FROM node:26-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94 AS runner
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
