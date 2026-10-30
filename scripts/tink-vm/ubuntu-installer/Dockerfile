# Spike: an installer image that holds a verified Ubuntu cloud image, the way the Talos installer
# image holds Talos. The context is built by ../ubuntu-demo.sh, which checks the image against
# Ubuntu's signed SHA256SUMS and puts it beside this file as ubuntu-cloudimg.img; the build checks
# its hash again. The entrypoint, install-ubuntu, writes the image to a disk. Nothing in it is
# signed by the lab: Ubuntu's shim is signed by Microsoft's UEFI CA, which the nodes' db holds.
FROM docker.io/library/alpine:3.24.3@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a
RUN apk add --no-cache qemu-img sgdisk dosfstools e2fsprogs efibootmgr util-linux tar
ARG IMAGE_SHA256
COPY ubuntu-cloudimg.img /ubuntu-cloudimg.img
RUN echo "$IMAGE_SHA256  /ubuntu-cloudimg.img" | sha256sum -c -
COPY install-ubuntu /usr/local/bin/install-ubuntu
ENTRYPOINT ["/usr/local/bin/install-ubuntu"]
