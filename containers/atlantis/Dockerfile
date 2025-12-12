FROM ghcr.io/runatlantis/atlantis:v0.38.0@sha256:db84af5f9202f6a0ef4c107c35a3821c6e80a25a6d43be71adedca9f3dbb740e
USER root
RUN echo https://downloads.1password.com/linux/alpinelinux/stable/ >> /etc/apk/repositories && \
    wget https://downloads.1password.com/linux/keys/alpinelinux/support@1password.com-61ddfc31.rsa.pub -P /etc/apk/keys && \
    apk add --no-cache 1password-cli && \
    op --version

# uid=100(atlantis) gid=1000(atlantis) groups=1000(atlantis)
USER 100:1000
