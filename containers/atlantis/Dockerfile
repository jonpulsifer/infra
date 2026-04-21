FROM ghcr.io/runatlantis/atlantis:v0.42.0@sha256:a8873d7281491407249ffbd9d0f55fc5829f6ab7f7152643da05857c32f606a9
USER root
RUN echo https://downloads.1password.com/linux/alpinelinux/stable/ >> /etc/apk/repositories && \
    wget https://downloads.1password.com/linux/keys/alpinelinux/support@1password.com-61ddfc31.rsa.pub -P /etc/apk/keys && \
    apk add --no-cache 1password-cli && \
    op --version

# uid=100(atlantis) gid=1000(atlantis) groups=1000(atlantis)
USER 100:1000
