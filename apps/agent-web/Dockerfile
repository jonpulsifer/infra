# apps/agent-web — ghostty-web terminal + PTY server + openclaw gateway.
#
# Build context is the REPO ROOT (the frontend lives in packages/agent-web-ui).
# Two images are produced from this one Dockerfile via --build-arg AGENT_SET:
#   AGENT_SET=full  -> ghcr.io/jonpulsifer/ai-agents (claude-code, opencode, pi, openclaw)
#   AGENT_SET=pi    -> local validation only (openclaw only)
#
#   docker build -f apps/agent-web/Dockerfile --build-arg AGENT_SET=full .

# ── Stage 1: Build ghostty-web (WASM + JS) ──────────────────
FROM node:24-bookworm-slim AS ghostty-builder

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git unzip xz-utils \
    && rm -rf /var/lib/apt/lists/*

ARG ZIG_VERSION=0.15.2
RUN curl -fsSL "https://ziglang.org/download/${ZIG_VERSION}/zig-x86_64-linux-${ZIG_VERSION}.tar.xz" \
      | tar -xJ -C /usr/local --strip-components=1 \
    && ln -s /usr/local/zig /usr/local/bin/zig

RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:$PATH"

ARG GHOSTTY_WEB_VERSION=main
WORKDIR /build
RUN git clone --recurse-submodules --depth 1 --branch ${GHOSTTY_WEB_VERSION} \
      https://github.com/coder/ghostty-web.git .
RUN bun install && bun run build

# ── Stage 2: Build native PTY dependencies ───────────────────
FROM node:24-bookworm-slim AS pty-builder

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
RUN npm install @lydell/node-pty ws

# ── Stage 3: Build frontend assets (HTML/CSS/JS) ─────────────
FROM oven/bun:latest AS frontend-builder

WORKDIR /build
COPY packages/agent-web-ui/package.json packages/agent-web-ui/bun.lock ./
RUN bun install --frozen-lockfile
COPY packages/agent-web-ui/src/ src/
COPY packages/agent-web-ui/public/ public/
COPY packages/agent-web-ui/build.ts ./
RUN bun run build

# ── Stage 4: Final image ────────────────────────────────────
# Base + init follow the upstream openclaw Docker guidance
# (https://docs.openclaw.ai/install/docker): node:24-bookworm-slim with tini
# as PID 1 for signal handling and zombie reaping (the PTY layer spawns shells).
FROM node:24-bookworm-slim

RUN apt-get update && apt-get -y upgrade && \
    apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      dnsutils \
      git \
      gnupg \
      jq \
      iproute2 \
      make \
      openssh-client \
      lsof \
      procps \
      iputils-ping \
      iperf3 \
      net-tools \
      ncat \
      nmap \
      fzf \
      bat \
      fd-find \
      rsync \
      ripgrep \
      strace \
      sudo \
      tree \
      tcpdump \
      tini \
      traceroute \
      yq \
      unzip \
      wget \
      xz-utils \
      zip \
      man-db \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       -o /etc/apt/keyrings/github-cli.gpg \
    && chmod go+r /etc/apt/keyrings/github-cli.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/github-cli.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

RUN ln -sf /usr/bin/batcat /usr/local/bin/bat \
    && ln -sf /usr/bin/fdfind /usr/local/bin/fd

# 1Password CLI
RUN curl -sS https://downloads.1password.com/linux/keys/1password.asc | \
      gpg --dearmor --output /usr/share/keyrings/1password-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/1password-archive-keyring.gpg] https://downloads.1password.com/linux/debian/$(dpkg --print-architecture) stable main" | \
      tee /etc/apt/sources.list.d/1password.list && \
    mkdir -p /etc/debsig/policies/AC2D62742012EA22/ && \
    curl -sS https://downloads.1password.com/linux/debian/debsig/1password.pol | \
      tee /etc/debsig/policies/AC2D62742012EA22/1password.pol && \
    mkdir -p /usr/share/debsig/keyrings/AC2D62742012EA22/ && \
    curl -sS https://downloads.1password.com/linux/keys/1password.asc | \
      gpg --dearmor --output /usr/share/debsig/keyrings/AC2D62742012EA22/debsig.gpg && \
    apt-get update && apt-get install -y --no-install-recommends 1password-cli && \
    rm -rf /var/lib/apt/lists/*

# bun runtime — reuse the binary from the frontend build stage (oven/bun)
COPY --from=frontend-builder /usr/local/bin/bun /usr/local/bin/bun

# Agent CLIs, installed globally with bun (not npm).
# BUN_INSTALL=/usr/local makes bun write bin shims to /usr/local/bin — always
# on PATH, including when the chart overrides PATH for npmTools — and packages
# under /usr/local/install/global. We ship the latest openclaw and then assert
# its prebuilt Control UI is present, so a bad upstream release fails the build
# instead of serving 503s at runtime.
ENV BUN_INSTALL=/usr/local

# openclaw is the gateway and is installed in every variant.
# renovate: datasource=npm versioning=npm; packageName=openclaw
RUN bun add -g openclaw \
    && test -f /usr/local/install/global/node_modules/openclaw/dist/control-ui/index.html

# AGENT_SET=full adds the coding-agent CLIs; AGENT_SET=pi ships openclaw only.
ARG AGENT_SET=full
# renovate: datasource=npm versioning=npm; packageName=@anthropic-ai/claude-code
# renovate: datasource=npm versioning=npm; packageName=opencode-ai
# renovate: datasource=npm versioning=npm; packageName=@earendil-works/pi-coding-agent
RUN if [ "$AGENT_SET" = "full" ]; then \
      bun add -g @anthropic-ai/claude-code opencode-ai \
      && bun add -g --ignore-scripts @earendil-works/pi-coding-agent ; \
    fi

# Install mise system-wide so it survives the /home/agent runtime volume mount.
# MISE_INSTALL_PATH: where the mise binary itself lives (on PATH already).
# MISE_SHIMS_DIR: where tool shims live — put them in /usr/local/bin so they're on
#   PATH for non-interactive shells (exec, cron, etc.) too, not just interactive bash.
RUN curl --proto '=https' --tlsv1.2 -fsSL https://mise.run \
      | MISE_INSTALL_PATH=/usr/local/bin/mise MISE_SHIMS_DIR=/usr/local/bin sh \
    && echo 'export PATH="${HOME}/.local/bin:${PATH}"' >> /etc/bash.bashrc \
    && echo 'eval "$(/usr/local/bin/mise activate bash)"' >> /etc/bash.bashrc \
    && mkdir -p /etc/profile.d \
    && echo 'export PATH="${HOME}/.local/bin:/usr/local/bin:${PATH}"' > /etc/profile.d/mise.sh

# ghostty-web runtime assets
COPY --from=ghostty-builder /build/dist /opt/ghostty-web/dist
COPY --from=ghostty-builder /build/ghostty-vt.wasm /opt/ghostty-web/ghostty-vt.wasm
COPY --from=pty-builder /build/node_modules /opt/ghostty-web/node_modules

# Frontend build output (HTML, CSS, JS, icons, fonts)
COPY --from=frontend-builder /build/dist /opt/ghostty-web/app

# Server + helpers
COPY packages/agent-web-ui/server.js /opt/ghostty-web/server.js
COPY apps/agent-web/agent-snapshot.sh /usr/local/bin/agent-snapshot
RUN chmod 0755 /usr/local/bin/agent-snapshot

# Agent user (non-root, dedicated to agent workloads)
RUN groupadd -g 1337 agent \
    && useradd -m -u 1337 -g agent -s /bin/bash agent \
    && echo "agent ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/agent \
    && chmod 440 /etc/sudoers.d/agent

WORKDIR /home/agent
RUN chown -R agent:agent /home/agent

# Persist agent home (tool configs, shell history, openclaw state, etc.)
VOLUME /home/agent

EXPOSE 8080
EXPOSE 18789
USER agent:agent

ENV HOME=/home/agent

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "node", "/opt/ghostty-web/server.js"]
