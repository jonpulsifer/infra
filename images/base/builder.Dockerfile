# Build-time image (downloads + GPG-verifies the Ubuntu rootfs in Cloud Build); runs as root.
# trivy:ignore:AVD-DS-0002
FROM alpine:edge

ENV WORKDIR /workspace
ENV PACKAGES gnupg make wget

RUN apk add --no-cache gnupg make wget && \
    mkdir -p ${WORKDIR}

WORKDIR ${WORKDIR}
