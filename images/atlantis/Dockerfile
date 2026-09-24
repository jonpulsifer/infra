FROM ghcr.io/runatlantis/atlantis:v0.47.1@sha256:5112319554630f6e4a93bfaf78c1fb9cea024a0eebd210e6563322c1c67df842
USER root

# Replaces the OpenTofu the base image bundles. Must equal opentofu in the root
# mise.toml, so a local plan runs the version Atlantis applies with.
# renovate: datasource=github-releases depName=opentofu/opentofu
ARG OPENTOFU_VERSION=1.12.6
RUN apk add --no-cache unzip \
    && curl -fsSL "https://github.com/opentofu/opentofu/releases/download/v${OPENTOFU_VERSION}/tofu_${OPENTOFU_VERSION}_linux_amd64.zip" -o /tmp/tofu.zip \
    && unzip -o /tmp/tofu.zip -d /usr/local/bin/ \
    && rm /tmp/tofu.zip \
    && chmod +x /usr/local/bin/tofu \
    && tofu --version \
    && apk del unzip

RUN echo https://downloads.1password.com/linux/alpinelinux/stable/ >> /etc/apk/repositories && \
    wget https://downloads.1password.com/linux/keys/alpinelinux/support@1password.com-61ddfc31.rsa.pub -P /etc/apk/keys && \
    apk add --no-cache 1password-cli && \
    op --version

# uid=100(atlantis) gid=1000(atlantis) groups=1000(atlantis)
USER 100:1000
