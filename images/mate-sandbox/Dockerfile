# syntax=docker/dockerfile:1
#
# The per-thread sandbox mate execs `opencode acp` in. Its tools are baked in
# because the sandbox's egress policy blocks their downloads.
FROM debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251 AS base

FROM base AS toolset
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      unzip \
      xz-utils \
    && rm -rf /var/lib/apt/lists/*

# renovate: datasource=github-releases depName=FiloSottile/age
ARG AGE_VERSION=1.3.2
# renovate: datasource=github-releases depName=sharkdp/bat
ARG BAT_VERSION=0.26.1
# renovate: datasource=npm depName=bun
ARG BUN_VERSION=1.4.2
# renovate: datasource=github-releases depName=open-policy-agent/conftest
ARG CONFTEST_VERSION=0.70.1
# Must equal d2 in the root mise.toml: `docs:diagrams` commits its output.
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
ARG MISE_VERSION=2026.9.12
# No Renovate datasource covers 1Password's CDN, so this pin moves by hand.
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
# Must equal opentofu in the root mise.toml: the repo's tasks run this binary
# in its place.
# renovate: datasource=github-releases depName=opentofu/opentofu
ARG TOFU_VERSION=1.12.6
# renovate: datasource=github-releases depName=mikefarah/yq
ARG YQ_VERSION=4.53.6

# gh goes to libexec: `gh` on PATH is the wrapper copied in below.
RUN set -eux; \
    mkdir -p /out/bin /out/libexec; \
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
    arc "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip"; \
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
    tar -xzf archive --no-same-owner -C /out/libexec --strip-components=2 "gh_${GH_VERSION}_linux_amd64/bin/gh"; \
    arc "https://get.helm.sh/helm-v${HELM_VERSION}-linux-amd64.tar.gz"; \
    tar -xzf archive --no-same-owner -C /out/bin --strip-components=1 linux-amd64/helm; \
    arc "https://github.com/kubernetes-sigs/kustomize/releases/download/kustomize%2Fv${KUSTOMIZE_VERSION}/kustomize_v${KUSTOMIZE_VERSION}_linux_amd64.tar.gz"; \
    tar -xzf archive --no-same-owner -C /out/bin kustomize; \
    arc "https://github.com/jdx/mise/releases/download/v${MISE_VERSION}/mise-v${MISE_VERSION}-linux-x64.tar.gz"; \
    tar -xzf archive --no-same-owner -C /out/bin --strip-components=2 mise/bin/mise; \
    arc "https://cache.agilebits.com/dist/1P/op2/pkg/v${OP_VERSION}/op_linux_amd64_v${OP_VERSION}.zip"; \
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
    chmod 0755 /out/bin/* /out/libexec/*

FROM base

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      procps \
      ripgrep \
      tini \
    && rm -rf /var/lib/apt/lists/*

# /usr/local/bin, because HOME is an emptyDir at runtime and Debian's
# /etc/profile resets PATH in login shells, dropping a prepended directory.
COPY --from=toolset /out/bin/ /usr/local/bin/
COPY --from=toolset /out/libexec/ /usr/local/libexec/

COPY gh /usr/local/bin/gh

# The CLI comes from the image that serves it, so the sandbox runs the build
# the apex serves. It is a Bun bundle: `kthx` on PATH is the shim copied in
# below, and `kthx upgrade` would install a second copy the shim never runs.
COPY --from=ghcr.io/jonpulsifer/kthx:latest@sha256:8497f1108ed3910343e69dabcbc45d477f3935f415eb6ec0661241fd1faf775b /app/apps/kthx/dist/kthx.tgz /tmp/kthx.tgz
RUN set -eux; \
    mkdir -m 0755 -p /usr/local/lib/kthx; \
    tar -xzf /tmp/kthx.tgz --no-same-owner -C /usr/local/lib/kthx --strip-components=1 \
      package/kthx.js package/version.json; \
    chmod 0644 /usr/local/lib/kthx/kthx.js /usr/local/lib/kthx/version.json; \
    rm /tmp/kthx.tgz

COPY kthx /usr/local/bin/kthx

COPY mise.toml /etc/mise/config.toml

# The platform package opencode-ai installs on linux/amd64. It needs AVX2;
# opencode-linux-x64-baseline is the build for nodes without it.
# renovate: datasource=npm depName=opencode-linux-x64
ARG OPENCODE_VERSION=1.18.31
RUN curl -fsSL "https://registry.npmjs.org/opencode-linux-x64/-/opencode-linux-x64-${OPENCODE_VERSION}.tgz" \
      | tar -xz --no-same-owner -C /usr/local/bin --strip-components=2 package/bin/opencode \
    && chmod 0755 /usr/local/bin/opencode

RUN groupadd -g 1337 agent \
    && useradd -m -u 1337 -g agent -s /bin/bash agent

USER 1337:1337
WORKDIR /home/agent

# HOME and the XDG roots sit on the pod's emptyDir. opencode's autoupdate and
# the kthx update check are off because both are root-owned and pinned.
ENV HOME=/home/agent \
    USER=agent \
    XDG_DATA_HOME=/home/agent/.local/share \
    XDG_CONFIG_HOME=/home/agent/.config \
    XDG_CACHE_HOME=/home/agent/.cache \
    XDG_STATE_HOME=/home/agent/.local/state \
    LANG=C.UTF-8 \
    TERM=dumb \
    NO_COLOR=1 \
    OPENCODE_DISABLE_AUTOUPDATE=1 \
    KTHX_NO_UPDATE_CHECK=1

# Runs as the sandbox uid, so a binary that cannot start fails the build.
# helm, kubectl, kustomize and pixlet reject `--version`.
RUN set -eux; \
    for tool in age age-keygen bat bun conftest d2 delta eza flux fzf gh jq kthx \
                mise op opencode promtool shellcheck shfmt sops terraform-docs tofu \
                yq; do \
      "$tool" --version >/dev/null; \
    done; \
    helm version >/dev/null; \
    kubectl version --client >/dev/null; \
    kustomize version >/dev/null; \
    pixlet version >/dev/null

# `gh auth token` needs no network. Through the wrapper it must print the token
# file's contents. It must also fail when mate empties the file between turns,
# but `set -e` ignores a `!` command, so the build does not enforce that case.
RUN set -eux; \
    d="$(mktemp -d)"; \
    printf %s 'ghs-a-token' >"$d/token"; \
    token="$(GH_CONFIG_DIR="$d/gh" MATE_GITHUB_TOKEN_FILE="$d/token" \
             gh auth token)"; \
    test "$token" = 'ghs-a-token'; \
    : >"$d/token"; \
    ! GH_CONFIG_DIR="$d/gh" MATE_GITHUB_TOKEN_FILE="$d/token" \
      gh auth token >/dev/null 2>&1; \
    rm -rf "$d"

# sleep is a keepalive: mate execs each session. tini reaps what those sessions
# orphan and forwards SIGTERM, so a pod delete is prompt.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
