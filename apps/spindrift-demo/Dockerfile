# syntax=docker/dockerfile:1
#
# Static site demo — build dist/ with build-time git facts, then serve the
# folder with bun.  The toolchain stays in the builder stage; the runtime
# image only carries the static files and a bun binary to serve them.
FROM cgr.dev/chainguard/node:latest-dev@sha256:5ca3303bfbcd7eeec7e71466d56a334c8f40323b59a92e174131bf038bdd81ca AS base
ARG BUN_VERSION=1.3.14
ENV BUN_INSTALL=/usr/local
USER root
RUN apk add --no-cache bash curl git \
  && curl -fsSL https://bun.sh/install | bash -s -- "bun-v${BUN_VERSION}"

FROM base AS builder
WORKDIR /app
COPY . .
RUN bun run build.ts

FROM cgr.dev/chainguard/node:latest@sha256:2b9627fec21321fad828adf6c5ceb91c6f377b772b48a738533a1225c0145a90 AS runner
ENV NODE_ENV=production \
  PORT=3000
WORKDIR /app
COPY --from=base /usr/local/bin/bun /usr/local/bin/bun
COPY --from=builder --chmod=755 /app/apps/spindrift-demo/dist ./dist
COPY --from=builder --chmod=755 /app/apps/spindrift-demo/serve.ts ./serve.ts
USER 65532:65532
EXPOSE 3000
ENTRYPOINT []
CMD ["/usr/local/bin/bun", "run", "serve.ts"]
