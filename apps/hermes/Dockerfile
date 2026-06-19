# hermes — deliberate brain/orchestrator agent
# Runs ONLY openclaw. No claude, no opencode.
# Deliberate tool selection: git, curl, jq, ripgrep, fd, bat, fzf, rsync, dnsutils, iproute2, lsof, strace, man-db, make, ca-certificates
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
    && rm -rf /var/lib/apt/lists/*

# Symlinks for Debian package names
RUN ln -sf /usr/bin/batcat /usr/local/bin/bat \
    && ln -sf /usr/bin/fdfind /usr/local/bin/fd

# 1Password CLI (for secrets access)
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

# bun runtime for global package installs
ENV BUN_INSTALL=/usr/local
RUN curl -fsSL https://bun.sh/install | bash

# openclaw — NO claude, NO opencode
RUN bun add -g openclaw

# mise — tool version manager, shims in /usr/local/bin for non-interactive shells
RUN curl --proto '=https' --tlsv1.2 -fsSL https://mise.run \
      | MISE_INSTALL_PATH=/usr/local/bin/mise MISE_SHIMS_DIR=/usr/local/bin sh \
    && echo 'export PATH="${HOME}/.local/bin:${PATH}"' >> /etc/bash.bashrc \
    && echo 'eval "$(/usr/local/bin/mise activate bash)"' >> /etc/bash.bashrc \
    && mkdir -p /etc/profile.d \
    && echo 'export PATH="${HOME}/.local/bin:/usr/local/bin:${PATH}"' > /etc/profile.d/mise.sh

# Agent user (non-root, uid 1337)
RUN groupadd -g 1337 agent \
    && useradd -m -u 1337 -g agent -s /bin/bash agent

WORKDIR /home/agent
RUN chown -R agent:agent /home/agent

# Persist agent home (configs, shell history, openclaw state, memory)
VOLUME /home/agent

EXPOSE 8080
EXPOSE 18789

USER agent:agent
ENV HOME=/home/agent

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "node", "-e", "require('openclaw')"]