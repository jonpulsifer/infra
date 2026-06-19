# Cloud Build worker that compiles kernels; needs root for build tooling and package installs.
# trivy:ignore:AVD-DS-0002
FROM ubuntu:resolute

ENV PACKAGES build-essential libncurses-dev bison flex libssl-dev libelf-dev

RUN apt-get -qqy update && apt-get -qqy upgrade && \
    apt-get -qqy install --no-install-recommends ${PACKAGES}

# google cloud build
WORKDIR /workspace
