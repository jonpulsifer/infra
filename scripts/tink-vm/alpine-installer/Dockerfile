# Spike: an installer image that is the OS, the way the Talos installer image is. The rootfs stage
# builds an Alpine root with apk; the uki stage packs its kernel and initramfs into one UKI with
# the root's label on the command line; the sign stage signs it; the last stage holds the root as a
# tarball, the signed UKI and install-alpine, which writes both to a disk.
#
# The sign stage copies a key from the build context, which only a throwaway key may be: the lab's
# pipeline would sign on the runner with sbsign, as .github/workflows/talos-images.yml signs HookOS,
# or through a BuildKit secret, so no layer ever holds the key.
FROM docker.io/library/alpine:3.24.3@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a AS rootfs
COPY rootfs/ /overlay/
RUN set -eux; \
  mkdir -p /rootfs/etc/apk /rootfs/etc/mkinitfs; \
  cp -r /etc/apk/keys /etc/apk/repositories /rootfs/etc/apk/; \
  cp /overlay/etc/mkinitfs/mkinitfs.conf /rootfs/etc/mkinitfs/; \
  apk add --root /rootfs --initdb --no-cache \
    alpine-base linux-lts linux-firmware-none openssh chrony e2fsprogs dosfstools tpm2-tools tpm2-tss-tcti-device; \
  cp -r /overlay/. /rootfs/; \
  for s in devfs dmesg mdev hwdrivers; do chroot /rootfs rc-update add "$s" sysinit; done; \
  for s in modules sysctl hostname bootmisc syslog hwclock networking; do chroot /rootfs rc-update add "$s" boot; done; \
  for s in sshd chronyd; do chroot /rootfs rc-update add "$s" default; done; \
  for s in mount-ro killprocs savecache; do chroot /rootfs rc-update add "$s" shutdown; done; \
  sed -i 's|^#ttyS0::|ttyS0::|' /rootfs/etc/inittab; \
  mkdir -p /rootfs/boot/efi; \
  tar -C /rootfs -cpf /alpine-rootfs.tar .

FROM docker.io/library/alpine:3.24.3@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a AS uki
RUN apk add --no-cache ukify systemd-efistub
COPY --from=rootfs /rootfs/boot/ /boot/
COPY --from=rootfs /rootfs/etc/os-release /os-release
COPY --from=rootfs /rootfs/lib/modules/ /modules/
RUN ukify build \
    --linux=/boot/vmlinuz-lts \
    --initrd=/boot/initramfs-lts \
    --stub=/usr/lib/systemd/boot/efi/linuxx64.efi.stub \
    --uname="$(ls /modules)" \
    --os-release=@/os-release \
    --cmdline="root=LABEL=alpine-root rootfstype=ext4 modules=ext4 console=tty0 console=ttyS0,115200" \
    --output=/alpine-unsigned.efi

FROM docker.io/library/alpine:3.24.3@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a AS sign
RUN apk add --no-cache sbsigntool
COPY --from=uki /alpine-unsigned.efi /alpine-unsigned.efi
COPY keys/uki-signing-key.pem keys/uki-signing-cert.pem /keys/
RUN sbsign --key /keys/uki-signing-key.pem --cert /keys/uki-signing-cert.pem \
    --output /alpine.efi /alpine-unsigned.efi \
  && sbverify --cert /keys/uki-signing-cert.pem /alpine.efi

FROM docker.io/library/alpine:3.24.3@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a
RUN apk add --no-cache sgdisk dosfstools e2fsprogs efibootmgr util-linux tar
COPY --from=rootfs /alpine-rootfs.tar /alpine-rootfs.tar
COPY --from=sign /alpine.efi /alpine.efi
COPY install-alpine /usr/local/bin/install-alpine
ENTRYPOINT ["/usr/local/bin/install-alpine"]
