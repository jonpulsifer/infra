# syntax=docker/dockerfile:1
#
# Static site demo — build dist/ with build-time git facts, then serve the
# folder with bun.  The toolchain stays in the builder stage; the runtime
# image only carries the static files and a bun binary to serve them.
FROM cgr.dev/chainguard/node:latest-dev@sha256:26283ca693a33c36fc69bed232aaf6996dfb14d048465488b3c868b8c5343665 AS base
ARG BUN_VERSION=1.4.0
ENV BUN_INSTALL=/usr/local
USER root
RUN apk add --no-cache bash curl \
  && curl -fsSL https://bun.sh/install | bash -s -- "bun-v${BUN_VERSION}"

FROM base AS builder
ARG BUILD_COMMIT=unknown
ARG BUILD_BRANCH=unknown
ARG BUILD_TIME
WORKDIR /app
COPY . .
RUN cd apps/spindrift-demo && BUILD_COMMIT="${BUILD_COMMIT}" BUILD_BRANCH="${BUILD_BRANCH}" BUILD_TIME="${BUILD_TIME:-$(date -Iseconds)}" bun run build.ts

FROM cgr.dev/chainguard/node:latest@sha256:716088322be7b5d08a5ae97d8d534f0d743ec06e16dc33ae170b015422262bd8 AS runner
# Redeclare so the commit the builder baked is visible to the running image
# as an env var the server reports on every page — the dynamic fact that
# says "this is build X" without you opening the UI.
ARG BUILD_COMMIT=unknown
ENV NODE_ENV=production \
  PORT=3000 \
  SPINDRIFT_BUILD=${BUILD_COMMIT}
WORKDIR /app
COPY --from=base /usr/local/bin/bun /usr/local/bin/bun
COPY --from=builder --chmod=755 /app/apps/spindrift-demo/dist ./dist
COPY --from=builder --chmod=755 /app/apps/spindrift-demo/serve.ts ./serve.ts
USER 65532:65532
EXPOSE 3000
ENTRYPOINT []
CMD ["/usr/local/bin/bun", "run", "serve.ts"]
