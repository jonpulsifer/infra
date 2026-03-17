# ── Stage 1: Build ghostty-web (WASM + JS) ──────────────────
FROM node:24-slim AS ghostty-builder

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
FROM node:24-slim AS pty-builder

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
RUN npm install @lydell/node-pty ws

# ── Stage 3: Build frontend assets (HTML/CSS/JS) ─────────────
FROM oven/bun:latest AS frontend-builder

WORKDIR /build
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY src/ src/
COPY public/ public/
COPY build.ts ./
RUN bun run build

# ── Stage 4: Final image ────────────────────────────────────
FROM node:24-slim

RUN apt-get update && apt-get -y upgrade && \
    apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      gnupg \
      jq \
      make \
      openssh-client \
      procps \
      ripgrep \
      unzip \
      wget \
      xz-utils \
      zip \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       -o /etc/apt/keyrings/github-cli.gpg \
    && chmod go+r /etc/apt/keyrings/github-cli.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/github-cli.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g \
      bun \
      @anthropic-ai/claude-code \
      opencode-ai \
      openclaw

# ghostty-web runtime assets
COPY --from=ghostty-builder /build/dist /opt/ghostty-web/dist
COPY --from=ghostty-builder /build/ghostty-vt.wasm /opt/ghostty-web/ghostty-vt.wasm
COPY --from=pty-builder /build/node_modules /opt/ghostty-web/node_modules

# Frontend build output (HTML, CSS, JS, icons, fonts)
COPY --from=frontend-builder /build/dist /opt/ghostty-web/app

# Server
COPY server.js /opt/ghostty-web/server.js

# Agent user (non-root, dedicated to agent workloads)
RUN groupadd -g 1337 agent \
    && useradd -m -u 1337 -g agent -s /bin/bash agent

WORKDIR /home/agent
RUN chown -R agent:agent /home/agent

# Persist agent home (tool configs, shell history, openclaw state, etc.)
VOLUME /home/agent

EXPOSE 8080
EXPOSE 18789
USER agent:agent

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "/opt/ghostty-web/server.js"]
