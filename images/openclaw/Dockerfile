# openclaw — minimal OpenClaw runtime only
# No agent brains, no ghostty-web. Just the OpenClaw runtime host.
# Multi-stage: build stage for bun packages, final stage is slim runtime
FROM node:24-bookworm-slim AS builder

ENV BUN_INSTALL=/usr/local
RUN curl -fsSL https://bun.sh/install | bash

# Install openclaw in builder so we can copy the final image cleanly
RUN bun add -g openclaw

# Verify openclaw dist exists before shipping
RUN test -f /usr/local/install/global/node_modules/openclaw/dist/control-ui/index.html

FROM node:24-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      dnsutils \
      git \
      gnupg \
      jq \
      procps \
      tini \
      unzip \
      wget \
      xz-utils \
    && rm -rf /var/lib/apt/lists/*

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

# Copy openclaw from builder
COPY --from=builder /usr/local/install/global /usr/local/install/global

# mise — shims in /usr/local/bin so non-interactive shells get them too
RUN curl --proto '=https' --tlsv1.2 -fsSL https://mise.run \
      | MISE_INSTALL_PATH=/usr/local/bin/mise MISE_SHIMS_DIR=/usr/local/bin sh \
    && echo 'export PATH="${HOME}/.local/bin:${PATH}"' >> /etc/bash.bashrc \
    && echo 'eval "$(/usr/local/bin/mise activate bash)"' >> /etc/bash.bashrc \
    && mkdir -p /etc/profile.d \
    && echo 'export PATH="${HOME}/.local/bin:/usr/local/bin:${PATH}"' > /etc/profile.d/mise.sh

# Minimal healthz server for OpenClaw
COPY --from=builder /usr/local/bin/bun /usr/local/bin/bun
COPY --from=builder /usr/local/bin/mise /usr/local/bin/mise

RUN echo '#!/usr/bin/env node\nfetch(\"http://127.0.0.1:18789/healthz\").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' > /healthz.js

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

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node /healthz.js

ENTRYPOINT ["/usr/bin/tini", "--", "node", "-e", "require('openclaw')"]