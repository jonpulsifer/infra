# syntax=docker/dockerfile:1
# Static site demo: builds dist/ with build-time git facts, then serves it with bun.
FROM cgr.dev/chainguard/node:latest-dev@sha256:81d77836dacab0c421ab4fbbf1cc2ffe56f9bc64793c1b077bbc1a30d61e1c05 AS base
# renovate: datasource=npm depName=bun
ARG BUN_VERSION=1.4.3
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
RUN cd apps/kthx-engine-demo && BUILD_COMMIT="${BUILD_COMMIT}" BUILD_BRANCH="${BUILD_BRANCH}" BUILD_TIME="${BUILD_TIME:-$(date -Iseconds)}" bun run build.ts

FROM cgr.dev/chainguard/node:latest@sha256:6a066f8decea77c67ef2772a78fad81df7a78a346d0b22a05fc9dac14537f2b0 AS runner
# ARGs are scoped to a stage; redeclare it so serve.ts can report SPINDRIFT_BUILD.
ARG BUILD_COMMIT=unknown
ENV NODE_ENV=production \
  PORT=3000 \
  SPINDRIFT_BUILD=${BUILD_COMMIT}
WORKDIR /app
COPY --from=base /usr/local/bin/bun /usr/local/bin/bun
COPY --from=builder --chmod=755 /app/apps/kthx-engine-demo/dist ./dist
COPY --from=builder --chmod=755 /app/apps/kthx-engine-demo/serve.ts ./serve.ts
USER 65532:65532
EXPOSE 3000
ENTRYPOINT []
CMD ["/usr/local/bin/bun", "run", "serve.ts"]
