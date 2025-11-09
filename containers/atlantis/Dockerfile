FROM ghcr.io/runatlantis/atlantis:v0.36.0@sha256:c1e648a4911aa6190d84fc0397fceede06f417d1acf3c7c0f1ce095eb8b923ce

USER root
RUN echo https://downloads.1password.com/linux/alpinelinux/stable/ >> /etc/apk/repositories && \
    wget https://downloads.1password.com/linux/keys/alpinelinux/support@1password.com-61ddfc31.rsa.pub -P /etc/apk/keys && \
    apk add --no-cache 1password-cli && \
    op --version

# uid=100(atlantis) gid=1000(atlantis) groups=1000(atlantis)
USER 100:1000
