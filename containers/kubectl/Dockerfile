FROM alpine:3.17
LABEL \
  maintainer=jonathan@pulsifer.ca \
  ca.lolwtf.os=linux \
  ca.lolwtf.distro=alpine
ARG KUBECTL_VERSION=${KUBECTL_VERSION:-1.26.0}
ADD --chown=65534:65534 https://dl.k8s.io/release/v${KUBECTL_VERSION}/bin/linux/amd64/kubectl /usr/bin
RUN chmod +x /usr/bin/kubectl
USER 65534:65534
ENTRYPOINT [ "/usr/bin/kubectl" ]
