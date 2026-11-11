# The tools the provision Template runs in HookOS, baked in so a node on the boot VLAN needs no
# package mirror: busybox's ntpd and util-linux's hwclock set the clock, sgdisk and util-linux wipe
# the disk, nvme-cli (sanitize, format) and util-linux's blkdiscard erase a retired
# node's whole disk, efibootmgr sets BootNext, docker-cli starts the detached reboot container, and
# curl, zstd, xz, tar and gzip fetch and unpack a disk image for the provision-image Template. tar
# is GNU tar: a cloud image tarball stores its disk as a GNU sparse member, which busybox tar
# rejects with "unknown typeflag".
# clusters/folly/tinkerbell/template.yaml and template-image.yaml pin this image by digest, which
# the containers workflow's delivery rewrites.
FROM docker.io/library/alpine:3.24.4@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf
RUN apk add --no-cache sgdisk util-linux efibootmgr docker-cli nvme-cli curl ca-certificates zstd xz tar \
 && for tool in nvme blkdiscard wipefs sgdisk efibootmgr docker sha256sum timeout curl zstd xz tar gzip mount; do command -v "$tool" >/dev/null || { echo "missing $tool" >&2; exit 1; }; done \
 && tar --version | grep -q 'GNU tar'
