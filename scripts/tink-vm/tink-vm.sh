#!/usr/bin/env bash
# A local QEMU machine for trying a Tinkerbell Template's actions without the lab: OVMF, swtpm, one
# virtio disk and user networking. Nothing here talks to folly's Tinkerbell or NetBox.
#
#   tink-vm.sh hookos UKI      boot a HookOS UKI with Secure Boot off and a command line that points
#                              the agent and the intake at nothing; the VM exits instead of rebooting
#   tink-vm.sh disk            boot whatever the disk and the firmware's boot order hold
#   tink-vm.sh enroll DB...    make a throwaway PK and KEK, put each DB certificate (PEM) in db and
#                              turn Secure Boot on in the VM's variable store
#   tink-vm.sh actions TEMPLATE DATA
#                              print a script that runs TEMPLATE's actions, rendered against DATA (a
#                              JSON object of .Hardware and the hardwareMap), the way tink-agent does
#   tink-vm.sh run TIMEOUT CMD run CMD on the VM's serial console shell
#   tink-vm.sh wait TIMEOUT TEXT
#                              wait for TEXT on the VM's serial console
#   tink-vm.sh stop            stop the VM and its TPM
#
# Needs qemu, OVMF (a Secure Boot build), swtpm, virt-firmware and openssl, for example from
# `nix shell nixpkgs#qemu_kvm nixpkgs#OVMFFull.fd nixpkgs#swtpm nixpkgs#python3Packages.virt-firmware
# nixpkgs#openssl`, with OVMF set to the OVMF package's FV directory, and go, yq and jq for actions.
# State lives in TINK_VM_DIR.
set -euo pipefail

dir=${TINK_VM_DIR:?set TINK_VM_DIR to a directory for the VM state}
: "${OVMF:?set OVMF to an OVMF FV directory with OVMF_CODE.fd and OVMF_VARS.fd}"
run=${XDG_RUNTIME_DIR:-/tmp}/tink-vm-$(basename "$dir")
here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$dir/tpm" "$run"

prepare() {
  [ -f "$dir/vars.fd" ] || install -m 0644 "$OVMF/OVMF_VARS.fd" "$dir/vars.fd"
  [ -f "$dir/disk.qcow2" ] || qemu-img create -q -f qcow2 "$dir/disk.qcow2" 8G
  if ! [ -S "$run/swtpm.sock" ] || ! pgrep -f "swtpm socket.*$run/swtpm.sock" >/dev/null; then
    rm -f "$run/swtpm.sock"
    swtpm socket --tpm2 --tpmstate "dir=$dir/tpm" --ctrl "type=unixio,path=$run/swtpm.sock" \
      --daemon --log "file=$dir/swtpm.log"
  fi
}

qemu() {
  : >"$dir/serial.log"
  qemu-system-x86_64 -machine q35,smm=on,accel=kvm -cpu host -m "${TINK_VM_MEM:-6144}" -smp 4 \
    -global driver=cfi.pflash01,property=secure,value=on \
    -drive "if=pflash,format=raw,unit=0,readonly=on,file=$OVMF/OVMF_CODE.fd" \
    -drive "if=pflash,format=raw,unit=1,file=$dir/vars.fd" \
    -chardev "socket,id=chrtpm,path=$run/swtpm.sock" -tpmdev emulator,id=tpm0,chardev=chrtpm \
    -device tpm-tis,tpmdev=tpm0 \
    -drive "if=virtio,format=qcow2,file=$dir/disk.qcow2" \
    -netdev user,id=n0 -device virtio-net-pci,netdev=n0,mac=52:54:00:12:34:56 \
    -no-reboot -display none \
    -chardev "socket,id=ser0,path=$run/serial.sock,server=on,wait=off,logfile=$dir/serial.log" \
    -serial chardev:ser0 -monitor "unix:$run/mon.sock,server,nowait" \
    "$@"
}

case ${1:-} in
  hookos)
    uki=${2:?hookos needs the HookOS UKI}
    if [ -e "$dir/enrolled" ]; then
      echo "Secure Boot is on in $dir/vars.fd: HookOS would run its signed command line; start over with a fresh vars.fd" >&2
      exit 1
    fi
    prepare
    # Under Secure Boot the stub ignores this line and uses the signed one, which posts to the
    # lab's intake and dials spore's Tinkerbell; enroll after the install, never before it.
    cmdline="facility= syslog_host=127.0.0.1 grpc_authority=127.0.0.1:42113 tinkerbell_tls=false"
    cmdline+=" tinkerbell_insecure_tls=false modules=loop,squashfs,sd-mod,usb-storage"
    cmdline+=" console=tty0 console=ttyS0,115200 talos.platform=metal fleet_intake_url="
    qemu -kernel "$uki" -append "$cmdline"
    ;;
  disk)
    prepare
    qemu
    ;;
  enroll)
    shift
    [ "$#" -gt 0 ] || {
      echo "enroll needs at least one db certificate" >&2
      exit 2
    }
    keys=$dir/keys
    mkdir -p "$keys"
    for k in PK KEK; do
      [ -f "$keys/$k.crt" ] || openssl req -quiet -new -x509 -newkey rsa:2048 -nodes -days 30 \
        -subj "/CN=tink-vm throwaway $k/" -keyout "$keys/$k.key" -out "$keys/$k.crt"
    done
    owner=$(cat /proc/sys/kernel/random/uuid)
    args=(--set-pk "$owner" "$keys/PK.crt" --add-kek "$owner" "$keys/KEK.crt")
    for c in "$@"; do args+=(--add-db "$owner" "$c"); done
    virt-fw-vars --inplace "$dir/vars.fd" "${args[@]}" --secure-boot
    touch "$dir/enrolled"
    ;;
  actions)
    template=${2:?actions needs a Template file}
    data=${3:?actions needs the render data as JSON}
    yq -r '.spec.data' "$template" | go run "$here/render.go" "$data" | yq -o=json '.' \
      | jq -r -f "$here/actions.jq"
    ;;
  run)
    timeout=${2:?run needs a timeout in seconds}
    shift 2
    python3 -I "$here/console.py" "$run/serial.sock" "$timeout" "$@"
    ;;
  wait)
    timeout=${2:?wait needs a timeout in seconds}
    text=${3:?wait needs the text to wait for}
    end=$((SECONDS + timeout))
    until grep -aqF -- "$text" "$dir/serial.log" 2>/dev/null; do
      [ "$SECONDS" -lt "$end" ] || {
        echo "no \"$text\" on the console after ${timeout}s" >&2
        exit 124
      }
      sleep 1
    done
    ;;
  stop)
    echo quit | socat - "UNIX-CONNECT:$run/mon.sock" 2>/dev/null || true
    pkill -f "swtpm socket.*$run/swtpm.sock" || true
    ;;
  *)
    sed -n '2,22p' "$0" >&2
    exit 2
    ;;
esac
