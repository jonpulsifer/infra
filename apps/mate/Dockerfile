# syntax=docker/dockerfile:1
#
# mate: one Bun process that runs its source as committed, with no build step.
FROM cgr.dev/chainguard/node:latest-dev@sha256:e7076475a5978df4626e4fcf99b368c4a8c2741b39249105f42a8fb4579bcb65 AS base
# renovate: datasource=npm depName=bun
ARG BUN_VERSION=1.4.2
ENV BUN_INSTALL=/usr/local \
  TURBO_TELEMETRY_DISABLED=1
USER root
RUN apk add --no-cache bash curl unzip \
  && curl -fsSL https://bun.sh/install | bash -s -- "bun-v${BUN_VERSION}"

FROM base AS pruner
# At least 2.11.2: 2.10.3's prune drops a nested lockfile entry that pi-ai's
# dependencies need, and the frozen install then refuses it.
# renovate: datasource=npm depName=turbo
ARG TURBO_VERSION=2.11.7
WORKDIR /app
COPY . .
RUN bun x "turbo@${TURBO_VERSION}" prune mate --docker

FROM base AS deps
WORKDIR /app
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/bun.lock ./bun.lock
RUN bun install --frozen-lockfile --production

FROM cgr.dev/chainguard/node:latest@sha256:f5b8ab65cbb411f9e1996f8c331c6d8df38291133f0c9b327a893646422237ad AS runner
ENV NODE_ENV=production \
  MATE_PORT=8080
WORKDIR /app
COPY --from=deps --chmod=755 /app ./
COPY --from=pruner --chmod=755 /app/out/full/apps/mate/src ./apps/mate/src
# `deps` has only the workspace manifests and symlinks, so each package's
# source comes from `pruner`.
COPY --from=pruner --chmod=755 /app/out/full/packages/mate-hands/src ./packages/mate-hands/src
COPY --from=pruner --chmod=755 /app/out/full/packages/mate-voice-protocol/src ./packages/mate-voice-protocol/src
COPY --from=pruner --chmod=755 /app/out/full/packages/pi-store-postgres/src ./packages/pi-store-postgres/src
# The agent's profile: the system prompt is the persona, the owner's AGENTS.md,
# the overrides, AGENTS.md plus an index of these skills. turbo prune leaves
# them out, so they come from the raw context.
COPY --from=pruner --chmod=755 /app/dotfiles/pi/mate/persona.md /app/dotfiles/pi/mate/persona.md
COPY --from=pruner --chmod=755 /app/dotfiles/pi/mate/memory.md /app/dotfiles/pi/mate/memory.md
COPY --from=pruner --chmod=755 /app/dotfiles/.agents/AGENTS.md /app/dotfiles/.agents/AGENTS.md
COPY --from=pruner --chmod=755 /app/AGENTS.md /app/AGENTS.md
COPY --from=pruner --chmod=755 /app/dotfiles/skills /app/dotfiles/skills
COPY --from=pruner --chmod=755 /app/.agents/skills /app/.agents/skills
COPY --from=base /usr/local/bin/bun /usr/local/bin/bun
RUN test -f /app/apps/mate/src/main.ts \
  && test -d /app/apps/mate/node_modules/@discordjs/ws \
  && test -d /app/apps/mate/node_modules/@earendil-works/pi-durable \
  && test -f /app/apps/mate/node_modules/@repo/mate-hands/src/protocol.ts \
  && test -f /app/apps/mate/node_modules/@repo/mate-voice-protocol/src/index.ts \
  && test -f /app/apps/mate/node_modules/@repo/pi-store-postgres/src/index.ts \
  && test -f /app/AGENTS.md \
  && test -s /app/dotfiles/pi/mate/persona.md \
  && test -s /app/dotfiles/pi/mate/memory.md \
  && test -s /app/dotfiles/.agents/AGENTS.md \
  && ls /app/dotfiles/skills/*/SKILL.md >/dev/null \
  && ls /app/.agents/skills/*/SKILL.md >/dev/null
WORKDIR /app/apps/mate
USER 65532:65532
EXPOSE 8080
ENTRYPOINT []
CMD ["/usr/local/bin/bun", "run", "src/main.ts"]
