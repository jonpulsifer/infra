# The tools the provision Template runs in HookOS, baked in so a node on the boot VLAN needs no
# package mirror: busybox's ntpd and util-linux's hwclock set the clock, sgdisk and util-linux wipe
# the disk, nvme-cli (format), hdparm (ATA secure erase) and util-linux's blkdiscard erase a retired
# node's whole disk, efibootmgr sets BootNext, and docker-cli starts the detached reboot container.
# clusters/folly/tinkerbell/template.yaml pins this image by digest, which the containers
# workflow's delivery rewrites.
FROM docker.io/library/alpine:3.24.3@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a
RUN apk add --no-cache sgdisk util-linux efibootmgr docker-cli nvme-cli hdparm \
 && for tool in nvme hdparm blkdiscard wipefs sgdisk efibootmgr docker sha256sum timeout; do command -v "$tool" >/dev/null || { echo "missing $tool" >&2; exit 1; }; done
