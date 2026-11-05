# syntax=docker/dockerfile:1
#
# gcsfuse for the kthx sites pod (clusters/offsite/apps/kthx-sites): the sidecar
# that mounts the sites bucket read-only for nginx. The release .deb is pinned by
# sha256, so a version bump moves GCSFUSE_SHA256 with it.
FROM debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2

# renovate: datasource=github-releases depName=GoogleCloudPlatform/gcsfuse
ARG GCSFUSE_VERSION=3.13.0
ARG GCSFUSE_SHA256=6052b700b0406c7b8579bd7c0d1bbb90d510ca3872167844a6af7294a69c0308

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl fuse3 \
    && curl -fsSLo /tmp/gcsfuse.deb "https://github.com/GoogleCloudPlatform/gcsfuse/releases/download/v${GCSFUSE_VERSION}/gcsfuse_${GCSFUSE_VERSION}_amd64.deb" \
    && echo "${GCSFUSE_SHA256}  /tmp/gcsfuse.deb" | sha256sum -c - \
    && apt-get install -y --no-install-recommends /tmp/gcsfuse.deb \
    && rm -rf /tmp/gcsfuse.deb /var/lib/apt/lists/* \
    && gcsfuse --version

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
