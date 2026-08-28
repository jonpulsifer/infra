# syntax=docker/dockerfile:1
#
# Static site demo — build dist/ with build-time git facts, then serve the
# folder with bun.  The toolchain stays in the builder stage; the runtime
# image only carries the static files and a bun binary to serve them.
FROM cgr.dev/chainguard/node:latest-dev@sha256:87c646948c4ee39b8b2abcb6e6e77008bedc1cbfec41a0c75ddca1a74ec3b691 AS base
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

FROM cgr.dev/chainguard/node:latest@sha256:d6ca8dfc9d0a8f369cd86c0bb6a8f9e4b304b3bb12aaf8fd26bd1352e6b6efc1 AS runner
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
