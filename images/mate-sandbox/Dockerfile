# mate-sandbox — the per-thread sandbox mate execs `opencode acp` in.
#
# One opencode binary plus what the sandbox proof needs around it: git for the
# checkout an init container clones at mint, ripgrep so opencode's grep and
# glob tools never reach for a download, curl and ca-certificates for the
# reachability proofs run from inside, procps for the orphan check after a
# deliberate stream close, and tini as PID 1.
#
# The container's main process is a keepalive, not the harness. mate opens
# `opencode acp` per session through pods/exec and holds its stdin open for
# the session's life; tini reaps whatever an exec'd session orphans and
# forwards SIGTERM to `sleep`, so a pod delete is prompt.
#
# Everything that varies per thread comes from the pod, none of it is baked:
#   - an emptyDir mounted at /home/agent — opencode's state is
#     $XDG_DATA_HOME/opencode/opencode.db and the image ships nothing there
#   - the checkout, cloned by an init container and passed as `--cwd`
#   - OPENCODE_API_KEY from the ESO-synced Secret — the one secret
#   - OPENCODE_CONFIG_CONTENT carrying the model, permission and mcp overrides
FROM debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      procps \
      ripgrep \
      tini \
    && rm -rf /var/lib/apt/lists/*

# opencode-ai@<version> resolves on linux/amd64 to this platform package; its
# binary is byte-identical to the GitHub release asset of the same version.
# The non-baseline build wants AVX2, which every x86 node in the fleet has;
# opencode-linux-x64-baseline is published in lockstep and is the one-word
# swap here if a node without it ever joins.
# `opencode --version` is the assertion: a binary that cannot start fails the
# build here rather than the first exec into a sandbox.
# renovate: datasource=npm depName=opencode-linux-x64
ARG OPENCODE_VERSION=1.18.31
RUN curl -fsSL "https://registry.npmjs.org/opencode-linux-x64/-/opencode-linux-x64-${OPENCODE_VERSION}.tgz" \
      | tar -xz --no-same-owner -C /usr/local/bin --strip-components=2 package/bin/opencode \
    && chmod 0755 /usr/local/bin/opencode \
    && opencode --version

RUN groupadd -g 1337 agent \
    && useradd -m -u 1337 -g agent -s /bin/bash agent

USER 1337:1337
WORKDIR /home/agent

# The environment the harness ran under in the bake-off. HOME and the XDG
# roots all sit under the mount the pod backs with an emptyDir; opencode
# creates its subdirectories itself. Autoupdate is off because the binary is
# root-owned, and because a harness that swaps itself out from under a live
# thread is not a version anyone can reason about afterwards.
ENV HOME=/home/agent \
    USER=agent \
    XDG_DATA_HOME=/home/agent/.local/share \
    XDG_CONFIG_HOME=/home/agent/.config \
    XDG_CACHE_HOME=/home/agent/.cache \
    XDG_STATE_HOME=/home/agent/.local/state \
    LANG=C.UTF-8 \
    TERM=dumb \
    NO_COLOR=1 \
    OPENCODE_DISABLE_AUTOUPDATE=1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
