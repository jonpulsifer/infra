# folly's Alpine fleet-boot image: the kernel and the initramfs of a RAM boot
# that attests a machine against fleetd and runs the boot fleetd answers, as
# the NixOS initrd of nix/images/fleet-boot.nix does, from Alpine's packages
# instead. The initramfs is the system: busybox, musl, kmod, the disk tools a
# run uses, Alpine's linux-lts kernel modules pruned to the lab's NICs, disks
# and TPMs, their firmware, the CA bundle, the static fleet-boot binary and
# init. No OpenRC, no udev daemon, no container runtime.
#
# The image carries the two files under /boot and the kernel's uname;
# .github/scripts/talos-netboot-build.sh packs them into one UKI with the
# command line of nix/images/fleet-boot.nix less its systemd unit, and
# talos-images.yml signs it with the HookOS key and publishes it beside the
# other two. clusters/folly/talos/netboot.json pins this image by digest, which
# the containers workflow's delivery rewrites. The context is the repository
# root (build.json), because the image builds apps/fleetd's fleet-boot.
#
# Alpine's stable branch holds one version of each package, so the packages are
# the branch's newest at build time; the base image's digest is the pin, and
# the published image's digest is what the release records.
FROM docker.io/library/golang:1.27-alpine AS build
# go.mod replaces pkcs11signer with ../../packages/pkcs11signer, so the tree keeps its layout.
WORKDIR /src/apps/fleetd
COPY packages/pkcs11signer/ /src/packages/pkcs11signer/
COPY apps/fleetd/go.mod apps/fleetd/go.sum ./
RUN go mod download
COPY apps/fleetd/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/fleet-boot ./cmd/fleet-boot

FROM docker.io/library/alpine:3.24.4@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf AS initramfs
# kmod prunes the modules and cpio and zstd pack the tree; the tree gets its own copies.
RUN apk add --no-cache kmod cpio zstd
# The initramfs's root, from the base image's repositories and keys. No scripts:
# linux-lts's would run mkinitfs, and busybox's applet links are made below.
# The e1000e, igb and igc drivers of the lab's Intel NICs need no firmware;
# r8169 and r8152 (Realtek) read rtl_nic, and tg3 (Broadcom) reads tigon.
# The disk tools are the NixOS image's initrdBin: fleet-boot runs wipefs,
# sgdisk, blkid -p, blkdiscard --force, efibootmgr, nvme and zstd, whose
# busybox applets are missing or take other flags. They install before
# busybox's links, which leave an existing file alone.
RUN apk add --no-cache --no-scripts --initdb --root /initramfs \
      --keys-dir /etc/apk/keys --repositories-file /etc/apk/repositories \
      busybox musl kmod xz zstd ca-certificates-bundle \
      wipefs blkid sgdisk util-linux-misc efibootmgr nvme-cli \
      linux-lts linux-firmware-rtl_nic linux-firmware-tigon \
 && chroot /initramfs /bin/busybox --install -s
COPY --from=build /out/fleet-boot /initramfs/usr/local/bin/fleet-boot
COPY images/fleet-boot-alpine/init /initramfs/init
COPY images/fleet-boot-alpine/build-initramfs.sh /usr/local/bin/build-initramfs
RUN build-initramfs /initramfs /out

FROM scratch
COPY --from=initramfs /out/ /boot/
