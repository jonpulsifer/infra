# Spike: an installer image that holds a verified Ubuntu cloud image, the way the Talos installer
# image holds Talos. The context is built by ../ubuntu-demo.sh, which checks the image against
# Ubuntu's signed SHA256SUMS and puts it beside this file as ubuntu-cloudimg.img; the build checks
# its hash again. The entrypoint, install-ubuntu, writes the image to a disk. Nothing in it is
# signed by the lab: Ubuntu's shim is signed by Microsoft's UEFI CA, which the nodes' db holds.
FROM docker.io/library/alpine:3.24.4@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf
RUN apk add --no-cache qemu-img sgdisk dosfstools e2fsprogs e2fsprogs-extra efibootmgr util-linux blkid tar
ARG IMAGE_SHA256
COPY ubuntu-cloudimg.img /ubuntu-cloudimg.img
RUN echo "$IMAGE_SHA256  /ubuntu-cloudimg.img" | sha256sum -c -
COPY install-ubuntu /usr/local/bin/install-ubuntu
ENTRYPOINT ["/usr/local/bin/install-ubuntu"]
