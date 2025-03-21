FROM gcr.io/trusted-builds/ubuntu-2404-base
LABEL maintainer=jonathan@pulsifer.ca \
      ca.pulsifer.os=linux \
      ca.pulsifer.distro=ubuntu \
      ca.pulsifer.codename=noble \
      ca.pulsifer.release=24.04

WORKDIR /tmp/build
COPY scripts scripts
RUN chmod +x ./scripts/*.sh \
      && ./scripts/base.sh \
      && ./scripts/packages.sh \
      && ./scripts/user.sh

COPY etc/environment /etc/
