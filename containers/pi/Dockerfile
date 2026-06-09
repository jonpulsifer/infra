# pi — openclaw agent with ghostty-web terminal UI
# Multi-stage: ghostty-builder (zig+wasm), pty-builder (node-pty), frontend-builder, final
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
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY src/ src/
COPY public/ public/
COPY build.ts ./
RUN bun run build

# ── Stage 4: Final image ────────────────────────────────────
FROM node:24-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      dnsutils \
      git \
      gnupg \
      iproute2 \
      jq \
      lsof \
      make \
      man-db \
      procps \
      ripgrep \
      rsync \
      strace \
      tini \
      unzip \
      wget \
      xz-utils \
      zip \
      fzf \
      bat \
      fd-find \
      yq \
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

# bun runtime + openclaw (NO claude, NO opencode)
ENV BUN_INSTALL=/usr/local
COPY --from=frontend-builder /usr/local/bin/bun /usr/local/bin/bun
RUN bun add -g openclaw \
 && test -f /usr/local/install/global/node_modules/openclaw/dist/control-ui/index.html

# mise — shims in /usr/local/bin for non-interactive shells
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
COPY --from=frontend-builder /build/dist /opt/ghostty-web/app

# Server
COPY server.js /opt/ghostty-web/server.js

# Agent user
RUN groupadd -g 1337 agent \
    && useradd -m -u 1337 -g agent -s /bin/bash agent

WORKDIR /home/agent
RUN chown -R agent:agent /home/agent

VOLUME /home/agent

EXPOSE 8080
EXPOSE 18789

USER agent:agent
ENV HOME=/home/agent

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "node", "/opt/ghostty-web/server.js"]