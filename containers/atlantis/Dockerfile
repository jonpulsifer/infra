FROM ghcr.io/runatlantis/atlantis:v0.41.0@sha256:634ffcdb7c1eb308349be81a09c3778a4fb4cb5b397c2ecf6d843f0e18d51bd7
USER root
RUN echo https://downloads.1password.com/linux/alpinelinux/stable/ >> /etc/apk/repositories && \
    wget https://downloads.1password.com/linux/keys/alpinelinux/support@1password.com-61ddfc31.rsa.pub -P /etc/apk/keys && \
    apk add --no-cache 1password-cli && \
    op --version

# uid=100(atlantis) gid=1000(atlantis) groups=1000(atlantis)
USER 100:1000
