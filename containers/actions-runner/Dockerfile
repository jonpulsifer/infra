FROM ghcr.io/actions/actions-runner:2.332.0
USER root
RUN apt-get update && apt-get -qqy upgrade &&\
    apt-get install -qqy --no-install-recommends \
      curl \
      git \
      jq \
      unzip \
      wget \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://raw.githubusercontent.com/tj/n/master/bin/n | bash -s current
# Install kubectl
RUN curl -fsSL "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" -o /usr/local/bin/kubectl \
    && chmod +x /usr/local/bin/kubectl
# Install argocd CLI
RUN curl -fsSL -o /usr/local/bin/argocd "https://github.com/argoproj/argo-cd/releases/latest/download/argocd-linux-amd64" \
    && chmod +x /usr/local/bin/argocd
# Install helm (often needed for ArgoCD app diffs)
RUN curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
# uid=1001(runner) gid=1001(runner) groups=1001(runner),27(sudo),123(docker)
USER 1001:1001
