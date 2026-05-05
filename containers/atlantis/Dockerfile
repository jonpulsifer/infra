FROM ghcr.io/runatlantis/atlantis:v0.43.0@sha256:eb08c9823713256cf5e5198666ae059e104ca3ec92ed500f1bd6f21aa2e1a3fc
USER root
RUN echo https://downloads.1password.com/linux/alpinelinux/stable/ >> /etc/apk/repositories && \
    wget https://downloads.1password.com/linux/keys/alpinelinux/support@1password.com-61ddfc31.rsa.pub -P /etc/apk/keys && \
    apk add --no-cache 1password-cli && \
    op --version

# uid=100(atlantis) gid=1000(atlantis) groups=1000(atlantis)
USER 100:1000
