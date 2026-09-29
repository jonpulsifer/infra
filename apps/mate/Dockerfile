# syntax=docker/dockerfile:1
#
# mate: one Bun process that runs its source as committed, with no build step.
FROM cgr.dev/chainguard/node:latest-dev@sha256:446b1779a5c4b3d5aca6b05d77b5d7a643eef87b34ec6ba5dc55fd0c9f81a6aa AS base
ARG BUN_VERSION=1.4.0
ENV BUN_INSTALL=/usr/local \
  TURBO_TELEMETRY_DISABLED=1
USER root
RUN apk add --no-cache bash curl unzip \
  && curl -fsSL https://bun.sh/install | bash -s -- "bun-v${BUN_VERSION}"

FROM base AS pruner
WORKDIR /app
COPY . .
RUN bun x turbo@2.10.3 prune mate --docker

FROM base AS deps
WORKDIR /app
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/bun.lock ./bun.lock
RUN bun install --frozen-lockfile --production

FROM cgr.dev/chainguard/node:latest@sha256:78a8d37362503110e162d3f4e3f60362ff85429a34e0c810c68828b98c699e88 AS runner
ENV NODE_ENV=production \
  MATE_PORT=8080
WORKDIR /app
COPY --from=deps --chmod=755 /app ./
COPY --from=pruner --chmod=755 /app/out/full/apps/mate/src ./apps/mate/src
# `deps` has only the workspace manifests and symlinks, so the package's
# source comes from `pruner`.
COPY --from=pruner --chmod=755 /app/out/full/packages/mate-hands/src ./packages/mate-hands/src
COPY --from=base /usr/local/bin/bun /usr/local/bin/bun
RUN test -f /app/apps/mate/src/main.ts \
  && test -d /app/apps/mate/node_modules/@discordjs/ws \
  && test -f /app/apps/mate/node_modules/@repo/mate-hands/src/protocol.ts
WORKDIR /app/apps/mate
USER 65532:65532
EXPOSE 8080
ENTRYPOINT []
CMD ["/usr/local/bin/bun", "run", "src/main.ts"]
