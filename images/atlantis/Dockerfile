FROM ghcr.io/runatlantis/atlantis:v0.46.0@sha256:e79363da6b55182d0cb13d7d9deb1cef51528f309a64254755c80df09cbfd698
USER root
RUN echo https://downloads.1password.com/linux/alpinelinux/stable/ >> /etc/apk/repositories && \
    wget https://downloads.1password.com/linux/keys/alpinelinux/support@1password.com-61ddfc31.rsa.pub -P /etc/apk/keys && \
    apk add --no-cache 1password-cli && \
    op --version

# uid=100(atlantis) gid=1000(atlantis) groups=1000(atlantis)
USER 100:1000
