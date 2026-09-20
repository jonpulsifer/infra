# syntax=docker/dockerfile:1
#
# mate-sandbox — the per-thread sandbox mate execs `opencode acp` in.
#
# opencode plus the toolset this repo's own tasks reach for: an agent asked to
# change infrastructure here has to render manifests, validate OpenTofu, lint
# shell, decrypt a sops file and open a pull request, and every one of those is
# a binary it cannot install for itself — the sandbox's egress allow-list is
# four FQDNs wide. What the image does not carry, the agent cannot do. The rest
# is what the sandbox proof needs around it: git for the checkout an init
# container clones at mint, ripgrep so opencode's grep and glob tools never
# reach for a download, curl and ca-certificates for the reachability proofs run
# from inside, procps for the orphan check after a deliberate stream close, and
# tini as PID 1.
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
FROM debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251 AS base

# Every tool is fetched in a stage that is thrown away, so the unpacking
# tooling never reaches a sandbox and the whole toolset lands as one layer.
FROM base AS toolset
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      unzip \
      xz-utils \
    && rm -rf /var/lib/apt/lists/*

# Pinned, because a `latest` in an image means two sandboxes minted a week
# apart run different tools and neither can be reproduced afterwards. Renovate
# reads these through `customManagers:dockerfileVersions`, which is already in
# `.github/renovate.json5` and is what the opencode pin below uses.
#
# Two of these have to agree with the repo rather than merely be current, and
# `.github/renovate.json5` groups each pair into one pull request so they
# cannot drift apart:
#   - tofu, because Atlantis runs the version the root `mise.toml` names and a
#     plan from a different one is a plan nobody will apply
#   - d2, because `docs:diagrams` commits its output and a version bump here
#     alone would rewrite every SVG the next time an agent ran the task
# renovate: datasource=github-releases depName=FiloSottile/age
ARG AGE_VERSION=1.3.2
# renovate: datasource=github-releases depName=sharkdp/bat
ARG BAT_VERSION=0.26.1
# renovate: datasource=npm depName=bun
ARG BUN_VERSION=1.4.2
# renovate: datasource=github-releases depName=open-policy-agent/conftest
ARG CONFTEST_VERSION=0.70.1
# renovate: datasource=github-releases depName=terrastruct/d2
ARG D2_VERSION=0.9.0
# renovate: datasource=github-releases depName=dandavison/delta
ARG DELTA_VERSION=0.19.2
# renovate: datasource=github-releases depName=eza-community/eza
ARG EZA_VERSION=0.23.5
# renovate: datasource=github-releases depName=fluxcd/flux2
ARG FLUX_VERSION=2.9.5
# renovate: datasource=github-releases depName=junegunn/fzf
ARG FZF_VERSION=0.74.4
# renovate: datasource=github-releases depName=cli/cli
ARG GH_VERSION=2.101.0
# renovate: datasource=github-releases depName=helm/helm
ARG HELM_VERSION=4.3.0
# renovate: datasource=github-releases depName=jqlang/jq extractVersion=^jq-(?<version>.*)$
ARG JQ_VERSION=1.8.2
# renovate: datasource=github-releases depName=kubernetes/kubernetes
ARG KUBECTL_VERSION=1.37.0
# renovate: datasource=github-releases depName=kubernetes-sigs/kustomize extractVersion=^kustomize/v(?<version>.*)$
ARG KUSTOMIZE_VERSION=5.8.1
# renovate: datasource=github-releases depName=jdx/mise
ARG MISE_VERSION=2026.9.11
# 1Password publishes the CLI from its own CDN and mirrors it nowhere Renovate
# has a datasource for, so this is the one pin that moves by hand.
ARG OP_VERSION=2.39.0
# renovate: datasource=github-releases depName=tronbyt/pixlet
ARG PIXLET_VERSION=0.54.0
# renovate: datasource=github-releases depName=prometheus/prometheus
ARG PROMETHEUS_VERSION=3.14.0
# renovate: datasource=github-releases depName=koalaman/shellcheck
ARG SHELLCHECK_VERSION=0.11.0
# renovate: datasource=github-releases depName=mvdan/sh
ARG SHFMT_VERSION=3.14.1
# renovate: datasource=github-releases depName=getsops/sops
ARG SOPS_VERSION=3.13.3
# renovate: datasource=github-releases depName=terraform-docs/terraform-docs
ARG TERRAFORM_DOCS_VERSION=0.24.0
# renovate: datasource=github-releases depName=opentofu/opentofu
ARG TOFU_VERSION=1.12.6
# renovate: datasource=github-releases depName=mikefarah/yq
ARG YQ_VERSION=4.53.6

# Each archive is stripped to the binaries alone. promtool is the reason this
# is spelled out rather than handed to a version manager: mise resolves it to
# the prometheus distribution and drags the 142 MB server binary along for a
# tool that lints rules, where naming the one path inside the same tarball
# costs 46 MB compressed.
RUN set -eux; \
    mkdir -p /out/bin; \
    cd "$(mktemp -d)"; \
    raw() { curl -fsSL --retry 3 --retry-all-errors -o "/out/bin/$1" "$2"; }; \
    arc() { curl -fsSL --retry 3 --retry-all-errors -o archive "$1"; }; \
    raw jq      "https://github.com/jqlang/jq/releases/download/jq-${JQ_VERSION}/jq-linux-amd64"; \
    raw kubectl "https://dl.k8s.io/release/v${KUBECTL_VERSION}/bin/linux/amd64/kubectl"; \
    raw shfmt   "https://github.com/mvdan/sh/releases/download/v${SHFMT_VERSION}/shfmt_v${SHFMT_VERSION}_linux_amd64"; \
    raw sops    "https://github.com/getsops/sops/releases/download/v${SOPS_VERSION}/sops-v${SOPS_VERSION}.linux.amd64"; \
    raw yq      "https://github.com/mikefarah/yq/releases/download/v${YQ_VERSION}/yq_linux_amd64"; \
    arc "https://github.com/FiloSottile/age/releases/download/v${AGE_VERSION}/age-v${AGE_VERSION}-linux-amd64.tar.gz"; \
    tar -xzf archive --no-same-owner -C /out/bin --strip-components=1 age/age age/age-keygen; \
    arc "https://github.com/sharkdp/bat/releases/download/v${BAT_VERSION}/bat-v${BAT_VERSION}-x86_64-unknown-linux-musl.tar.gz"; \
    tar -xzf archive --no-same-owner -C /out/bin --strip-components=1 "bat-v${BAT_VERSION}-x86_64-unknown-linux-musl/bat"; \
    curl -fsSL --retry 3 --retry-all-errors -o archive "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip"; \
    unzip -q -j archive bun-linux-x64/bun -d /out/bin; \
    arc "https://github.com/open-policy-agent/conftest/releases/download/v${CONFTEST_VERSION}/conftest_${CONFTEST_VERSION}_Linux_x86_64.tar.gz"; \
    tar -xzf archive --no-same-owner -C /out/bin conftest; \
    arc "https://github.com/terrastruct/d2/releases/download/v${D2_VERSION}/d2-v${D2_VERSION}-linux-amd64.tar.gz"; \
    tar -xzf archive --no-same-owner -C /out/bin --strip-components=2 "d2-v${D2_VERSION}/bin/d2"; \
    arc "https://github.com/dandavison/delta/releases/download/${DELTA_VERSION}/delta-${DELTA_VERSION}-x86_64-unknown-linux-musl.tar.gz"; \
    tar -xzf archive --no-same-owner -C /out/bin --strip-components=1 "delta-${DELTA_VERSION}-x86_64-unknown-linux-musl/delta"; \
    arc "https://github.com/eza-community/eza/releases/download/v${EZA_VERSION}/eza_x86_64-unknown-linux-musl.tar.gz"; \
    tar -xzf archive --no-same-owner -C /out/bin ./eza; \
    arc "https://github.com/fluxcd/flux2/releases/download/v${FLUX_VERSION}/flux_${FLUX_VERSION}_linux_amd64.tar.gz"; \
    tar -xzf archive --no-same-owner -C /out/bin flux; \
    arc "https://github.com/junegunn/fzf/releases/download/v${FZF_VERSION}/fzf-${FZF_VERSION}-linux_amd64.tar.gz"; \
    tar -xzf archive --no-same-owner -C /out/bin fzf; \
    arc "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz"; \
    tar -xzf archive --no-same-owner -C /out/bin --strip-components=2 "gh_${GH_VERSION}_linux_amd64/bin/gh"; \
    arc "https://get.helm.sh/helm-v${HELM_VERSION}-linux-amd64.tar.gz"; \
    tar -xzf archive --no-same-owner -C /out/bin --strip-components=1 linux-amd64/helm; \
    arc "https://github.com/kubernetes-sigs/kustomize/releases/download/kustomize%2Fv${KUSTOMIZE_VERSION}/kustomize_v${KUSTOMIZE_VERSION}_linux_amd64.tar.gz"; \
    tar -xzf archive --no-same-owner -C /out/bin kustomize; \
    arc "https://github.com/jdx/mise/releases/download/v${MISE_VERSION}/mise-v${MISE_VERSION}-linux-x64.tar.gz"; \
    tar -xzf archive --no-same-owner -C /out/bin --strip-components=2 mise/bin/mise; \
    curl -fsSL --retry 3 --retry-all-errors -o archive "https://cache.agilebits.com/dist/1P/op2/pkg/v${OP_VERSION}/op_linux_amd64_v${OP_VERSION}.zip"; \
    unzip -q -j archive op -d /out/bin; \
    arc "https://github.com/tronbyt/pixlet/releases/download/v${PIXLET_VERSION}/pixlet_v${PIXLET_VERSION}_linux-amd64.tar.gz"; \
    tar -xzf archive --no-same-owner -C /out/bin pixlet; \
    arc "https://github.com/prometheus/prometheus/releases/download/v${PROMETHEUS_VERSION}/prometheus-${PROMETHEUS_VERSION}.linux-amd64.tar.gz"; \
    tar -xzf archive --no-same-owner -C /out/bin --strip-components=1 "prometheus-${PROMETHEUS_VERSION}.linux-amd64/promtool"; \
    arc "https://github.com/koalaman/shellcheck/releases/download/v${SHELLCHECK_VERSION}/shellcheck-v${SHELLCHECK_VERSION}.linux.x86_64.tar.xz"; \
    tar -xJf archive --no-same-owner -C /out/bin --strip-components=1 "shellcheck-v${SHELLCHECK_VERSION}/shellcheck"; \
    arc "https://github.com/terraform-docs/terraform-docs/releases/download/v${TERRAFORM_DOCS_VERSION}/terraform-docs-v${TERRAFORM_DOCS_VERSION}-linux-amd64.tar.gz"; \
    tar -xzf archive --no-same-owner -C /out/bin terraform-docs; \
    arc "https://github.com/opentofu/opentofu/releases/download/v${TOFU_VERSION}/tofu_${TOFU_VERSION}_linux_amd64.tar.gz"; \
    tar -xzf archive --no-same-owner -C /out/bin tofu; \
    chmod 0755 /out/bin/*

FROM base

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      procps \
      ripgrep \
      tini \
    && rm -rf /var/lib/apt/lists/*

# /usr/local/bin rather than a directory of its own: /home/agent is an emptyDir
# at runtime, so anything under HOME is masked, and anything else needs a PATH
# that survives the agent's own shells — Debian's /etc/profile assigns PATH
# outright, so a login shell opencode spawns would drop a prepended directory
# and keep this one.
COPY --from=toolset /out/bin/ /usr/local/bin/

# mise is the repo's command source of truth, so the agent has to be able to
# run `mise run <task>`; the settings that keep it from also trying to manage
# the tools above are in the file itself.
COPY mise.toml /etc/mise/config.toml

# opencode-ai@<version> resolves on linux/amd64 to this platform package; its
# binary is byte-identical to the GitHub release asset of the same version.
# The non-baseline build wants AVX2, which every x86 node in the fleet has;
# opencode-linux-x64-baseline is published in lockstep and is the one-word
# swap here if a node without it ever joins.
# renovate: datasource=npm depName=opencode-linux-x64
ARG OPENCODE_VERSION=1.18.31
RUN curl -fsSL "https://registry.npmjs.org/opencode-linux-x64/-/opencode-linux-x64-${OPENCODE_VERSION}.tgz" \
      | tar -xz --no-same-owner -C /usr/local/bin --strip-components=2 package/bin/opencode \
    && chmod 0755 /usr/local/bin/opencode

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

# Every binary is started as the uid that will start it, so one that cannot run
# — a wrong architecture, a missing shared library, a truncated download — fails
# the build here rather than the first thread that needs it. The four spelled
# out separately answer `version` and reject `--version`, and kubectl's would
# go looking for a cluster without `--client`.
RUN set -eux; \
    for tool in age age-keygen bat bun conftest d2 delta eza flux fzf gh jq mise \
                op opencode promtool shellcheck shfmt sops terraform-docs tofu yq; do \
      "$tool" --version >/dev/null; \
    done; \
    helm version >/dev/null; \
    kubectl version --client >/dev/null; \
    kustomize version >/dev/null; \
    pixlet version >/dev/null

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
