# The tools the provision Template runs in HookOS, baked in so a node on the boot VLAN needs no
# package mirror: busybox's ntpd and util-linux's hwclock set the clock, sgdisk and util-linux wipe
# the disk, nvme-cli (sanitize, format) and util-linux's blkdiscard erase a retired
# node's whole disk, efibootmgr sets BootNext, docker-cli starts the detached reboot container, and
# curl, zstd, xz, tar and gzip fetch and unpack a disk image for the provision-image Template.
# clusters/folly/tinkerbell/template.yaml and template-image.yaml pin this image by digest, which
# the containers workflow's delivery rewrites.
FROM docker.io/library/alpine:3.24.3@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a
RUN apk add --no-cache sgdisk util-linux efibootmgr docker-cli nvme-cli curl ca-certificates zstd xz \
 && for tool in nvme blkdiscard wipefs sgdisk efibootmgr docker sha256sum timeout curl zstd xz tar gzip mount; do command -v "$tool" >/dev/null || { echo "missing $tool" >&2; exit 1; }; done
