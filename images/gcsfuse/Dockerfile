# syntax=docker/dockerfile:1
#
# gcsfuse for the kthx sites pod (clusters/offsite/apps/kthx-sites): the sidecar
# that mounts the sites bucket read-only for nginx. The release .deb is pinned by
# sha256, so a version bump moves GCSFUSE_SHA256 with it.
FROM debian:trixie-slim@sha256:8aa5a7bf5a1955bddbe7d74fcdd0b91ab30e74362a8b73af672b0481b35b44a0

# renovate: datasource=github-releases depName=GoogleCloudPlatform/gcsfuse
ARG GCSFUSE_VERSION=3.13.1
ARG GCSFUSE_SHA256=e0b1b07f8f71fa7955a76eee77ff5d5ea37e9ba3fb77fab7b56aa416eeb3305f

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl fuse3 \
    && curl -fsSLo /tmp/gcsfuse.deb "https://github.com/GoogleCloudPlatform/gcsfuse/releases/download/v${GCSFUSE_VERSION}/gcsfuse_${GCSFUSE_VERSION}_amd64.deb" \
    && echo "${GCSFUSE_SHA256}  /tmp/gcsfuse.deb" | sha256sum -c - \
    && apt-get install -y --no-install-recommends /tmp/gcsfuse.deb \
    && rm -rf /tmp/gcsfuse.deb /var/lib/apt/lists/* \
    && gcsfuse --version

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
