#!/usr/bin/env bash
# Spike: install Alpine on a local VM through the provision-alpine Template's actions, then boot it
# under Secure Boot. Steps: boot folly's HookOS UKI (Secure Boot off, agent and intake pointed at
# nothing), build ./alpine-installer in HookOS's Docker as CI would, put the node payload where the
# attest step would, run the Template's actions as tink-agent would (the reboot action ends the
# VM), enroll a throwaway PK and KEK and a db of the throwaway Alpine UKI certificate and the lab's
# two, and boot the disk. Nothing leaves the VM but its pulls from Docker Hub, GHCR and Alpine's
# mirror; attest is off, so tink-attest never runs.
#
# HOOKOS_UKI names a HookOS UKI; unset, the latest talos-folly release's asset is downloaded.
# Needs what tink-vm.sh needs, plus gh (for the download), ssh-keygen and python3.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
work=${TINK_VM_DIR:?set TINK_VM_DIR to a directory for the VM state}
port=${TINK_VM_HTTP_PORT:-8088}
vm() { bash "$here/tink-vm.sh" "$@"; }
step() { printf '%s %s\n' "$(date -u +%T)" "$*"; }

srv=$work/srv keys=$work/keys
rm -rf "$work/disk.qcow2" "$work/vars.fd" "$work/enrolled" "$work/tpm" "$srv"
mkdir -p "$srv" "$keys"

if [ -z "${HOOKOS_UKI:-}" ]; then
  tag=$(gh release list -R jonpulsifer/infra -L 50 --json tagName -q '[.[].tagName | select(startswith("talos-folly/"))][0]')
  step "downloading HookOS from $tag"
  gh release download "$tag" -R jonpulsifer/infra -p hookos-amd64-secureboot-uki.efi -D "$work" --clobber
  HOOKOS_UKI=$work/hookos-amd64-secureboot-uki.efi
fi

[ -f "$keys/uki-signing-key.pem" ] || openssl req -quiet -new -x509 -newkey rsa:2048 -nodes -days 30 \
  -subj "/CN=tink-vm throwaway Alpine UKI/" -keyout "$keys/uki-signing-key.pem" -out "$keys/uki-signing-cert.pem"
[ -f "$keys/node-ssh" ] || ssh-keygen -q -t ed25519 -N '' -C tink-vm -f "$keys/node-ssh"

ctx=$work/ctx
rm -rf "$ctx"
mkdir -p "$ctx/keys"
cp -r "$here/alpine-installer/." "$ctx/"
cp "$keys/uki-signing-key.pem" "$keys/uki-signing-cert.pem" "$ctx/keys/"
tar -C "$ctx" --owner=0 --group=0 -cf "$srv/ctx.tar" .

# What decision 1's mTLS fetch would hand the node. The console autologin is the spike's own, so
# this script can drive the installed system.
pl=$work/payload
rm -rf "$pl"
mkdir -p "$pl/etc" "$pl/root/.ssh"
echo tink-vm-alpine >"$pl/etc/hostname"
install -m 0600 "$keys/node-ssh.pub" "$pl/root/.ssh/authorized_keys"
chmod 0700 "$pl/root/.ssh"
cat >"$pl/etc/inittab" <<'EOF'
::sysinit:/sbin/openrc sysinit
::sysinit:/sbin/openrc boot
::wait:/sbin/openrc default
tty1::respawn:/sbin/getty 38400 tty1
ttyS0::respawn:/sbin/getty -n -l /bin/sh -L 115200 ttyS0 vt100
::ctrlaltdel:/sbin/reboot
::shutdown:/sbin/openrc shutdown
EOF
tar -C "$pl" --owner=0 --group=0 -czf "$srv/payload.tar.gz" .

data='{"Hardware":{"Interfaces":[{"DHCP":{"MAC":"52:54:00:12:34:56"}}],"Disks":["/dev/vda"]},
  "attest":"false","wipe":"true","retire":"false","install":"true",
  "installer_image":"alpine-installer:spike","attest_url":"https://attest.invalid",
  "ntp_server":"time.cloudflare.com"}'
vm actions "$here/alpine-installer/template.yaml" "$data" >"$srv/actions.sh"

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
vm run 900 "$d docker build -q -t alpine-installer:spike $host/ctx.tar"
step "running the Template's actions"
vm run 900 "$d sh -c 'mkdir -p /tmp/fleet && wget -qO /tmp/fleet/payload.tar.gz $host/payload.tar.gz && wget -qO /tmp/actions.sh $host/actions.sh && sh /tmp/actions.sh'"
wait "$qemu" || true
step "HookOS rebooted; the VM exited"

vm enroll "$keys/uki-signing-cert.pem" "$repo/clusters/folly/talos/secureboot/hookos-signing-cert.pem" \
  "$repo/clusters/folly/talos/secureboot/uki-signing-cert.pem" >/dev/null 2>&1
step "Secure Boot on; booting the disk"
vm disk &
qemu=$!
vm wait 120 "Starting sshd"
step "installed Alpine is up"
vm run 60 'grep -a "" /etc/alpine-release; hostname; uname -r; cat /proc/cmdline; dmesg | grep -i "secure boot"; mountpoint -q /sys/kernel/security || mount -t securityfs securityfs /sys/kernel/security; tpm2_eventlog /sys/kernel/security/tpm0/binary_bios_measurements 2>/dev/null | grep -c EV_EFI_BOOT_SERVICES_APPLICATION'
vm run 5 poweroff >/dev/null 2>&1 || true
wait "$qemu" || true
step "done"
