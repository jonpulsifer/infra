# syntax=docker/dockerfile:1
# Static site demo: builds dist/ with build-time git facts, then serves it with bun.
FROM cgr.dev/chainguard/node:latest-dev@sha256:43c334f3a02ad976d558840f4a5f9a785e67acc51c8d7e3d77fbae47a4a39c52 AS base
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

FROM cgr.dev/chainguard/node:latest@sha256:78a8d37362503110e162d3f4e3f60362ff85429a34e0c810c68828b98c699e88 AS runner
# ARGs are scoped to a stage; redeclare it so serve.ts can report SPINDRIFT_BUILD.
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
