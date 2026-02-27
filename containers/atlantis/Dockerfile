FROM ghcr.io/runatlantis/atlantis:v0.40.0@sha256:bdf219f4ee5a87435ef1f1b0ffc39cf8e86d39bd67d2fac6d86f25a8500c4ce2
USER root
RUN echo https://downloads.1password.com/linux/alpinelinux/stable/ >> /etc/apk/repositories && \
    wget https://downloads.1password.com/linux/keys/alpinelinux/support@1password.com-61ddfc31.rsa.pub -P /etc/apk/keys && \
    apk add --no-cache 1password-cli && \
    op --version

# uid=100(atlantis) gid=1000(atlantis) groups=1000(atlantis)
USER 100:1000
