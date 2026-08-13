FROM ghcr.io/actions/actions-runner:2.336.0
USER root
RUN apt-get update && apt-get -qqy upgrade &&\
    apt-get install -qqy --no-install-recommends \
      curl \
      git \
      jq \
      libatomic1 \
      unzip \
      wget \
    && rm -rf /var/lib/apt/lists/*
# Install node on the LTS line. `n current` tracked the newest release of all, so
# the version moved on every rebuild with nothing asserting the result still ran.
# `lts` still moves — it rolls to Node 26 in October — which is why libatomic1
# above stays: Node 26 links it and this slim base does not carry it otherwise.
# `node --version` is the assertion, so a node that cannot start fails the build
# here rather than at `bun install` in CI.
RUN curl -fsSL https://raw.githubusercontent.com/tj/n/master/bin/n | bash -s lts \
    && node --version
# Install kubectl
RUN curl -fsSL "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" -o /usr/local/bin/kubectl \
    && chmod +x /usr/local/bin/kubectl
# Install argocd CLI
RUN curl -fsSL -o /usr/local/bin/argocd "https://github.com/argoproj/argo-cd/releases/latest/download/argocd-linux-amd64" \
    && chmod +x /usr/local/bin/argocd
# Install helm (often needed for ArgoCD app diffs)
RUN curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
# Install yq. Deliberately mikefarah's Go yq from its release rather than the
# apt package of the same name, which is a Python jq wrapper with different
# semantics -- and it is mise's yq that scripts in this repo are written
# against, so the two have to be the same program. `yq --version` is the
# assertion: a yq that cannot start fails the image build rather than a job.
RUN curl -fsSL -o /usr/local/bin/yq "https://github.com/mikefarah/yq/releases/latest/download/yq_linux_amd64" \
    && chmod +x /usr/local/bin/yq \
    && yq --version
USER 1001:1001
