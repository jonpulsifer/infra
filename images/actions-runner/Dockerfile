FROM ghcr.io/actions/actions-runner:2.336.0
USER root
# libatomic1 is for node: Node 26 links it and this slim base lacks it.
RUN apt-get update && apt-get -qqy upgrade &&\
    apt-get install -qqy --no-install-recommends \
      curl \
      git \
      jq \
      libatomic1 \
      unzip \
      wget \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://raw.githubusercontent.com/tj/n/master/bin/n | bash -s lts \
    && node --version
RUN curl -fsSL "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" -o /usr/local/bin/kubectl \
    && chmod +x /usr/local/bin/kubectl
RUN curl -fsSL -o /usr/local/bin/argocd "https://github.com/argoproj/argo-cd/releases/latest/download/argocd-linux-amd64" \
    && chmod +x /usr/local/bin/argocd
RUN curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
# mikefarah's Go yq, the one mise installs for the repo's scripts. Ubuntu's yq
# package is a Python jq wrapper with different semantics.
RUN curl -fsSL -o /usr/local/bin/yq "https://github.com/mikefarah/yq/releases/latest/download/yq_linux_amd64" \
    && chmod +x /usr/local/bin/yq \
    && yq --version
USER 1001:1001
