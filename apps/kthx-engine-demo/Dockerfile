# syntax=docker/dockerfile:1
# Static site demo: builds dist/ with build-time git facts, then serves it with bun.
FROM cgr.dev/chainguard/node:latest-dev@sha256:617061855f341917060d95d164930fd949ed19e66fdc2918eabd2eefe2b29ae6 AS base
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
RUN cd apps/kthx-engine-demo && BUILD_COMMIT="${BUILD_COMMIT}" BUILD_BRANCH="${BUILD_BRANCH}" BUILD_TIME="${BUILD_TIME:-$(date -Iseconds)}" bun run build.ts

FROM cgr.dev/chainguard/node:latest@sha256:890c242118f6624fde2cdf8d8b03808e6f46c09eda8cf6a1c963a7abcbd8e9f0 AS runner
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
