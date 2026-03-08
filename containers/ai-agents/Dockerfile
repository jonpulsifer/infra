FROM node:24-slim

RUN apt-get update && \
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
      opencode-ai

WORKDIR /home/node
RUN chown -R 1000:1000 /home/node

USER 1000:1000

ENTRYPOINT ["/bin/bash"]
