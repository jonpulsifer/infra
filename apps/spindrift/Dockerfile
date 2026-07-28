# syntax=docker/dockerfile:1
#
# One image (§19). Today it starts one process — `web`; `reconciler` is the
# second entrypoint off this same image and arrives with the deploy loop.
#
# The client is built here and **served as files at runtime**, which is what
# keeps the compile-time toolchain out of the running container. The server
# entry (`src/web/server.ts`) imports no HTML module, so Tailwind, the bundler,
# and TypeScript's toolchain are all build-stage only; `bun install
# --production` in the `deps` stage is what actually drops them, and
# `test/web/routes.test.ts` is what stops an import from quietly putting one
# back.
#
# `src/web/dev.ts` is the other entry and does the opposite — Bun's HTML import,
# compiled on demand, so `bun run dev` needs no build step. That convenience is
# the thing production is not paying for.
FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS base
ARG BUN_VERSION=1.3.14
ENV BUN_INSTALL=/usr/local \
  TURBO_TELEMETRY_DISABLED=1
RUN apk add --no-cache bash curl libc6-compat \
  && curl -fsSL https://bun.sh/install | bash -s -- "bun-v${BUN_VERSION}"

FROM base AS pruner
WORKDIR /app
COPY . .
RUN bun x turbo@2.10.3 prune spindrift --docker

# Everything, so the client can be compiled.
FROM base AS builder
WORKDIR /app
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/bun.lock ./bun.lock
RUN bun install --frozen-lockfile
COPY --from=pruner /app/out/full/ .
RUN bun run build --filter=spindrift

# The runtime's dependencies alone, resolved from the same lockfile so the two
# stages cannot disagree about a version.
FROM base AS deps
WORKDIR /app
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/bun.lock ./bun.lock
RUN bun install --frozen-lockfile --production

# Supply-chain tools are release binaries rather than packages from Alpine's
# moving repositories. Versions and publisher-reported digests are both pinned;
# the build fails before copying a byte whose digest does not match.
FROM base AS supply-chain-tools
ARG TARGETARCH
ARG COSIGN_VERSION=3.0.6
ARG SLSA_VERIFIER_VERSION=2.7.1
RUN set -eux; \
  case "${TARGETARCH}" in \
    amd64) \
      cosign_sha='c956e5dfcac53d52bcf058360d579472f0c1d2d9b69f55209e256fe7783f4c74'; \
      slsa_sha='946dbec729094195e88ef78e1734324a27869f03e2c6bd2f61cbc06bd5350339' ;; \
    arm64) \
      cosign_sha='bedac92e8c3729864e13d4a17048007cfafa79d5deca993a43a90ffe018ef2b8'; \
      slsa_sha='5d3b2349ede7bfec19e7a21569f18b9f7410145ad12e9584b175370669e14061' ;; \
    *) echo "unsupported target architecture: ${TARGETARCH}" >&2; exit 1 ;; \
  esac; \
  curl -fsSL \
    "https://github.com/sigstore/cosign/releases/download/v${COSIGN_VERSION}/cosign-linux-${TARGETARCH}" \
    -o /usr/local/bin/cosign; \
  echo "${cosign_sha}  /usr/local/bin/cosign" | sha256sum -c -; \
  curl -fsSL \
    "https://github.com/slsa-framework/slsa-verifier/releases/download/v${SLSA_VERIFIER_VERSION}/slsa-verifier-linux-${TARGETARCH}" \
    -o /usr/local/bin/slsa-verifier; \
  echo "${slsa_sha}  /usr/local/bin/slsa-verifier" | sha256sum -c -; \
  chmod 0755 /usr/local/bin/cosign /usr/local/bin/slsa-verifier

FROM base AS runner
ENV NODE_ENV=production \
  PORT=3000
WORKDIR /app
# The chart runs this as uid 65532 with a read-only root filesystem, so
# everything is copied world-readable rather than owned by a build user.
COPY --from=deps --chmod=755 /app ./
COPY --from=builder --chmod=755 /app/apps/spindrift/src ./apps/spindrift/src
COPY --from=builder --chmod=755 /app/apps/spindrift/dist ./apps/spindrift/dist
COPY --from=supply-chain-tools /usr/local/bin/cosign /usr/local/bin/cosign
COPY --from=supply-chain-tools /usr/local/bin/slsa-verifier /usr/local/bin/slsa-verifier
WORKDIR /app/apps/spindrift
USER 65532:65532
EXPOSE 3000
CMD ["bun", "run", "src/web/server.ts"]
