#!/usr/bin/env bash
set -eu

# ubuntu version
MAJOR_VERSION="18.04"
PATCH_VERSION="3"

# this is where you want the custom iso to end up
# default: 2018-08-18-ubuntu-18.04.1.iso
CUSTOM_ISO_PATH="$(date +%Y-%m-%d)-ubuntu-${MAJOR_VERSION}.${PATCH_VERSION}.iso"

# where we build
WORKDIR="build"
ISO_MOUNT_DIR="mount"
CD_IMAGE_DIR="cd-image"

# location of the ISO based on MAJOR_VERSION (16, 18)
case "${MAJOR_VERSION:0:2}" in
  16) BASE_URL="http://releases.ubuntu.com/${MAJOR_VERSION}";; # XENIAL
  18) BASE_URL="http://cdimage.ubuntu.com/releases/${MAJOR_VERSION}/release";; # BIONIC
esac
ISO_FILENAME="ubuntu-${MAJOR_VERSION}.${PATCH_VERSION}-server-amd64.iso"
ISO_URL="${BASE_URL}/${ISO_FILENAME}"

# get machine type
case $(uname -s) in
  Linux)  OS=linux;;
  Darwin) OS=mac;;
  *) { echo "This script works on macOS only sry bout that"; exit 1; };;
esac

# run as root check
# ! [ "$(id -u)" = "0" ] && { echo "Please run this script as root"; exit 1; }

# dependencies
dependencies=(curl gpg2 mkisofs)
for dep in "${dependencies[@]}"; do
    command -v "${dep}" >/dev/null || { echo "Can not find ${dep}. Please ensure it is installed and in your PATH"; exit 1; }
done


# create the dirs
create_dirs() {
    mkdir -p "${WORKDIR}" "${WORKDIR}/${ISO_MOUNT_DIR}" "${WORKDIR}/${CD_IMAGE_DIR}"
}

# clean up when we're done no matter wat
cleanup() {
    # only unmount if there is an error
    if [ $? -gt 0 ]; then
      if [ "${OS}" = "linux" ]; then
        unmount_iso "${ISO_MOUNT_DIR}"
      elif [ "${OS}" = "macos" ]; then
        unmount_iso "${ATTACHED_DISK}"
      fi
    fi
    echo "Clean up by running these commands:"
    echo "  rm -rv ${WORKDIR}/${CD_IMAGE_DIR}"
    echo "  rmdir ${WORKDIR}/${ISO_MOUNT_DIR}"
}
# traps exits, SIGINT and SIGTERM
trap cleanup EXIT INT TERM

# downloads
download_iso() {
    [ -f "${ISO_FILENAME}" ] || curl -OJL "${ISO_URL}"
}

download_checksums() {
    curl -OJL "${BASE_URL}/SHA256SUMS"
    curl -OJL "${BASE_URL}/SHA256SUMS.gpg"
}

verify_files() {
    gpg2 --keyserver hkps://keyserver.ubuntu.com --recv-keys 0xFBB75451 0xEFE21092
    gpg2 --verify SHA256SUMS.gpg SHA256SUMS

    # probably a better way to do this
    { shasum -a 256 -c SHA256SUMS 2>&1 | grep OK; } || { download_iso && verify_files; }
}

unpack_iso() {
    if [ "${OS}" = "macos" ]; then
        # macOS mount
        # https://unix.stackexchange.com/questions/298685/can-a-mac-mount-a-debian-install-cd
        ATTACHED_DISK=$(hdiutil attach -nomount "${ISO_FILENAME}" | head -n 1 | awk '{print $1}')
        mount -t cd9660 "${ATTACHED_DISK}" "${ISO_MOUNT_DIR}"
        # copy iso contents
        rsync -av "${ISO_MOUNT_DIR}" "${CD_IMAGE_DIR}"
        unmount_iso "${ATTACHED_DISK}"
    elif [ "${OS}" = "linux" ]; then
        mount -o loop "${ISO_FILENAME}" "${ISO_MOUNT_DIR}"
        # copy iso contents
        rsync -av "${ISO_MOUNT_DIR}" "${CD_IMAGE_DIR}"
        unmount_iso "${ISO_MOUNT_DIR}"
    fi
}

unmount_iso() {
    if [ "${OS}" = "macos" ]; then
        [ -z "$1" ] && { echo "Something went wrong, please manually unmount the ISO"; exit 1; }
        umount "$1"
        hdiutil detach "$1"
    elif [ "${OS}" = "linux" ]; then
        umount "$1"
    fi
}

edit_bootloader() {
    # set timeout to 1s
    sed -i'' -e 's/^timeout 300/timeout 10/' ${CD_IMAGE_DIR}/${ISO_MOUNT_DIR}/isolinux/isolinux.cfg
    # set default to the LABEL custom
    sed -i'' -e 's/^default.*/default custom/' ${CD_IMAGE_DIR}/${ISO_MOUNT_DIR}/isolinux/isolinux.cfg
    # add LABEL custom
    tee -a ${CD_IMAGE_DIR}/${ISO_MOUNT_DIR}/isolinux/isolinux.cfg <<EOF
LABEL custom
  menu label ^CUSTOM installation (preseed)
  kernel /install/vmlinuz
  append auto file=/cdrom/preseed/custom.seed console-setup/ask_detect=false console-setup/layoutcode=us console-setup/modelcode=pc105 debconf/frontend=noninteractive debian-installer=en_US grub-installer/bootdev=/dev/sda fb=false initrd=/install/initrd.gz ramdisk_size=16384 root=/dev/ram rw kbd-chooser/method=us keyboard-configuration/layout=USA keyboard-configuration/variant=USA locale=en_US netcfg/get_domain=vm netcfg/get_hostname=packer noapic --
EOF
}
copy_preseed() {
    cp ../preseed.cfg ${CD_IMAGE_DIR}/${ISO_MOUNT_DIR}/preseed/custom.seed
}

repack_iso() {
    mkisofs -r -V "Ubuntu ${MAJOR_VERSION} preseed" \
            -cache-inodes \
            -J -l -b isolinux/isolinux.bin \
            -c isolinux/boot.cat -no-emul-boot \
            -boot-load-size 4 -boot-info-table \
            -o "${CUSTOM_ISO_PATH}" "${CD_IMAGE_DIR}/${ISO_MOUNT_DIR}"
}

########################
# THIS IS THE ORDER OF OPERATIONS

# create and enter working dirs
create_dirs
cd "${WORKDIR}"

# download and verify
download_iso
download_checksums
verify_files

# following https://help.ubuntu.com/community/InstallCDCustomization
unpack_iso
copy_preseed
edit_bootloader
repack_iso

# we done
exit 0
