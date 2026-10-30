#!/usr/bin/env bash
# Spike: install Ubuntu 24.04 on a local VM through the provision-ubuntu Template's actions, then
# boot it under Secure Boot with the db of the lab's nodes. Steps: fetch and verify the pinned cloud
# image, boot folly's HookOS UKI (Secure Boot off, agent and intake pointed at nothing), build
# ./ubuntu-installer in HookOS's Docker as CI would, put the node's cloud-init user-data and an install code where the
# attest step would, run the Template's actions as tink-agent would (the reboot action ends the VM), enroll
# a throwaway PK and KEK and the nodes' db (the Microsoft UEFI CAs and the lab's two certificates),
# boot the disk, read the Secure Boot and TPM state from inside, and show that a changed byte in
# shim, and in GRUB, stops the boot. Nothing leaves the VM but its pulls from Docker Hub, GHCR,
# Alpine's mirror and Ubuntu's archive (cloud-init installs tpm2-tools); attest is off, so
# tink-attest never runs.
#
# HOOKOS_UKI names a HookOS UKI; unset, the latest talos-folly release's asset is downloaded.
# NODE_DB names the raw efivarfs dump of a node's db; unset, the certificates in ./db are used, the
# ones riptide's db holds besides the lab's. TINK_VM_MEM defaults to 10240 MiB here, since HookOS
# keeps the installer image in memory.
# Needs what tink-vm.sh needs, plus gh (for the download), gpg, curl, ssh-keygen and python3.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
work=${TINK_VM_DIR:?set TINK_VM_DIR to a directory for the VM state}
port=${TINK_VM_HTTP_PORT:-8088}
export TINK_VM_MEM=${TINK_VM_MEM:-10240}
vm() { bash "$here/tink-vm.sh" "$@"; }
step() { printf '%s %s\n' "$(date -u +%T)" "$*"; }
log=$work/serial.log

# wait_for TIMEOUT EXTENDED-REGEX: wait for the pattern on the serial console.
wait_for() {
  local end=$((SECONDS + $1))
  until grep -aqE -- "$2" "$log" 2>/dev/null; do
    [ "$SECONDS" -lt "$end" ] || {
      echo "no match for \"$2\" on the console after ${1}s" >&2
      return 124
    }
    sleep 1
  done
}

# boot_disk: start the disk's boot in the background with a fresh console log.
boot_disk() {
  : >"$log"
  vm disk &
}

# down: wait for the VM to exit, as it does when the guest powers off or the firmware gives up.
down() {
  local end=$((SECONDS + ${1:-120})) disk=$work/disk.qcow2
  while pgrep -f "qemu-system-x86_64.*$disk" >/dev/null; do
    [ "$SECONDS" -lt "$end" ] || {
      vm stop >/dev/null 2>&1 || true
      return 0
    }
    sleep 1
  done
}

# tamper_test LABEL FILE REGEX: boot the good disk, change one byte of FILE on the ESP, boot again
# and wait for the refusal REGEX.
tamper_test() {
  cp --reflink=auto "$work/disk-good.qcow2" "$work/disk.qcow2"
  boot_disk
  wait_for 120 "login: |root@" || true
  vm run 30 "tamper $2 && sync && poweroff" >/dev/null 2>&1 || true
  down
  step "$1: one byte of $2 changed; booting"
  boot_disk
  if wait_for 90 "$3"; then
    step "$1: refused"
    sleep 1
    sed -E 's/\x1b\[[0-9;]*H/\n/g; s/\x1b\[[0-9;?=]*[A-Za-z]//g' "$log" | tr -d '\r' \
      | grep -aE "Access Denied|Verification failed" | sed -E 's/^[│ ]+//; s/[│ ]+$//; s/^/    /' | head -n 4
  else
    step "$1: NOT refused"
    tail -n 20 "$log" | sed 's/^/    /'
    status=1
  fi
  vm stop >/dev/null 2>&1 || true
  down
}

srv=$work/srv keys=$work/keys dl=$work/downloads
rm -rf "$work/disk.qcow2" "$work/disk-good.qcow2" "$work/vars.fd" "$work/enrolled" "$work/tpm" "$srv"
mkdir -p "$srv" "$keys" "$dl"
: >"$log"
status=0

if [ -z "${HOOKOS_UKI:-}" ]; then
  tag=$(gh release list -R jonpulsifer/infra -L 50 --json tagName -q '[.[].tagName | select(startswith("talos-folly/"))][0]')
  step "downloading HookOS from $tag"
  gh release download "$tag" -R jonpulsifer/infra -p hookos-amd64-secureboot-uki.efi -D "$work" --clobber
  HOOKOS_UKI=$work/hookos-amd64-secureboot-uki.efi
fi

step "fetching and verifying the Ubuntu cloud image"
img=$(bash "$here/ubuntu-installer/fetch-image" "$dl")
sha256=$(sha256sum "$img" | cut -d' ' -f1)
step "verified $(basename "$img") $sha256"

[ -f "$keys/node-ssh" ] || ssh-keygen -q -t ed25519 -N '' -C tink-vm -f "$keys/node-ssh"

ctx=$work/ctx
rm -rf "$ctx"
mkdir -p "$ctx"
cp "$here/ubuntu-installer/Dockerfile" "$here/ubuntu-installer/install-ubuntu" "$ctx/"
ln -f "$img" "$ctx/ubuntu-cloudimg.img" 2>/dev/null || cp "$img" "$ctx/ubuntu-cloudimg.img"
tar -C "$ctx" --owner=0 --group=0 -cf "$srv/ctx.tar" .

data='{"Hardware":{"Interfaces":[{"DHCP":{"MAC":"52:54:00:12:34:56","Hostname":"tink-vm-ubuntu"}}],
  "Disks":["/dev/vda"]},
  "attest":"false","wipe":"true","retire":"false","install":"true",
  "installer_image":"ubuntu-installer:spike"}'
vm actions "$here/ubuntu-installer/template.yaml" "$data" >"$srv/actions.sh"

# What decision 1's mTLS fetch would hand the node: its cloud-init user-data, with the harness's SSH
# key (the installer adds meta-data from the Hardware's hostname). The console autologin and the
# helpers are the spike's own, so this script can drive the installed system.
pl=$work/payload
rm -rf "$pl"
seed=$pl/var/lib/cloud/seed/nocloud
mkdir -p "$seed" "$pl/usr/local/sbin"
install -m 0755 "$here/ubuntu-installer/pcr7-authorities" "$pl/usr/local/sbin/pcr7-authorities"
cat >"$seed/user-data" <<EOF
#cloud-config
ssh_authorized_keys:
  - $(cat "$keys/node-ssh.pub")
package_update: true
packages:
  - tpm2-tools
write_files:
  - path: /etc/systemd/system/serial-getty@ttyS0.service.d/autologin.conf
    content: |
      [Service]
      ExecStart=
      ExecStart=-/sbin/agetty --autologin root --noclear 115200 %I \$TERM
runcmd:
  - systemctl daemon-reload
  - systemctl restart serial-getty@ttyS0.service
EOF
cat >"$pl/usr/local/sbin/tamper" <<'EOF'
#!/bin/sh
# Inverts the byte at offset 8192 of each file, which is inside the Authenticode-hashed image.
set -eu
for f in "$@"; do
  b=$(dd if="$f" bs=1 skip=8192 count=1 2>/dev/null | od -An -tu1 | tr -d ' ')
  printf "$(printf '\\%03o' $((b ^ 255)))" | dd of="$f" bs=1 seek=8192 conv=notrunc 2>/dev/null
  echo "tamper: $f byte 8192 $b -> $((b ^ 255))"
done
EOF
chmod 0755 "$pl/usr/local/sbin/tamper"
tar -C "$pl" --owner=0 --group=0 -czf "$srv/payload.tar.gz" .

# The code stands in for the one talos-attest answers; the Template's wipe-disk needs it to exist.
head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n' >"$srv/install_code"
python3 -I -m http.server --bind 127.0.0.1 --directory "$srv" "$port" >/dev/null 2>&1 &
http=$!
trap 'kill $http 2>/dev/null || true; vm stop >/dev/null 2>&1 || true' EXIT

step "booting HookOS"
vm hookos "$HOOKOS_UKI" &
qemu=$!
vm wait 180 "(ns: getty) HookOS"
step "HookOS shell up"

# The getty's docker is an alias with -it; a script runs hook-docker's own.
d="nerdctl -n services.linuxkit exec hook-docker"
host=http://10.0.2.2:$port
until vm run 10 "$d docker info >/dev/null 2>&1" >/dev/null; do sleep 2; done
step "HookOS's Docker is up"
step "building the installer image in HookOS (the CI build)"
vm run 900 "$d docker build -q --build-arg IMAGE_SHA256=$sha256 -t ubuntu-installer:spike $host/ctx.tar"
step "running the Template's actions"
vm run 1200 "$d sh -c 'mkdir -p /worker/fleet && wget -qO /worker/fleet/payload.tar.gz $host/payload.tar.gz && wget -qO /worker/fleet/install_code $host/install_code && wget -qO /tmp/actions.sh $host/actions.sh && sh /tmp/actions.sh'"
wait "$qemu" || true
step "HookOS rebooted; the VM exited"

dbdir=$work/db
rm -rf "$dbdir"
mkdir -p "$dbdir"
if [ -n "${NODE_DB:-}" ]; then
  python3 -I "$here/db-certs.py" "$NODE_DB" "$dbdir" >/dev/null
else
  cp "$here"/db/*.pem "$dbdir/"
  cp "$repo/clusters/folly/talos/secureboot/uki-signing-cert.pem" "$dbdir/fml-secure-boot.pem"
  cp "$repo/clusters/folly/talos/secureboot/hookos-signing-cert.pem" "$dbdir/fml-hookos-secure-boot.pem"
fi
vm enroll "$dbdir"/*.pem >/dev/null 2>&1
step "Secure Boot on with $(find "$dbdir" -name '*.pem' | wc -l) db certificates; booting the disk"
boot_disk
wait_for 600 "Cloud-init v\..* finished at"
step "installed Ubuntu is up and cloud-init finished"
vm run 120 'grep PRETTY_NAME /etc/os-release; hostname; uname -r; cat /proc/cmdline; echo; mokutil --sb-state; dmesg | grep -i "secureboot"; ls -l /dev/tpm0 /dev/tpmrm0; cat /sys/class/tpm/tpm0/tpm_version_major; tpm2_pcrread sha256:0,4,7; echo; pcr7-authorities'
vm run 60 'sync; poweroff' >/dev/null 2>&1 || true
down
cp --reflink=auto "$work/disk.qcow2" "$work/disk-good.qcow2"
step "evidence read; tamper tests"

tamper_test "tampered shim" "/boot/efi/EFI/ubuntu/shimx64.efi /boot/efi/EFI/BOOT/BOOTX64.EFI" "Access Denied"
tamper_test "tampered GRUB" "/boot/efi/EFI/ubuntu/grubx64.efi" "Verification failed"
step "done"
exit "$status"
