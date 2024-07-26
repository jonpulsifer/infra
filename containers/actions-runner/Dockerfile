FROM ghcr.io/actions/actions-runner:2.318.0
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

# uid=1001(runner) gid=1001(runner) groups=1001(runner),27(sudo),123(docker)
USER 1001:1001
