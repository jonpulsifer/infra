#!/usr/bin/env bash
# Tests talos-installer-verify.sh against stand-in installers: each holds a
# small PE32+ with imager's UKI layout of .cmdline sections, signed with a
# throwaway code-signing certificate. Needs crane, objdump, openssl, python3
# and sbsigntool.

set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
script="$here/talos-installer-verify.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# Talos fills in the placeholders, so they stay literal.
# shellcheck disable=SC2016
url='https://enroll.lolwtf.ca/talos/config?uuid=${uuid}&code=${code}'
base='talos.platform=metal console=tty0 slab_nomerge pti=on consoleblank=0 printk.devkmsg=on selinux=1 module.sig_enforce=1 proc_mem.force_override=never'
wipe=talos.experimental.wipe=system:EPHEMERAL,STATE

# shellcheck source=.github/scripts/talos-uki-testlib.sh
. "$here/talos-uki-testlib.sh"

for name in signer other; do
  certificate "$work" "$name"
done

# Builds the installer tarball <name>.tar from a UKI with the given sections,
# signed by the signer.
installer() {
  local name=$1 dir="$work/$1"
  shift
  mkdir -p "$dir/usr/install/amd64"
  pe "$dir/unsigned.efi" "$@"
  sbsign --key "$work/signer.key" --cert "$work/signer.pem" \
    --output "$dir/usr/install/amd64/vmlinuz.efi" "$dir/unsigned.efi" >/dev/null 2>&1
  tar -C "$dir" -cf "$dir/layer.tar" usr
  crane append -f "$dir/layer.tar" -t "example.invalid/installer:$name" -o "$work/$name.tar" 2>/dev/null
}

expect_pass() {
  local name=$1 cert=${2:-signer}
  bash "$script" "$work/$cert.pem" "$work/$name.tar" "$url" >/dev/null 2>&1 || fail "$name: want a pass"
}

expect_fail() {
  local name=$1 cert=${2:-signer}
  if bash "$script" "$work/$cert.pem" "$work/$name.tar" "$url" >/dev/null 2>&1; then
    fail "$name: want a failure"
  fi
}

# profiles <name> <default command line> [reset command line]
profiles() {
  local name=$1 default=$2 reset=${3-"$2 $wipe"}
  installer "$name" .cmdline "$default" .profile 'ID=reset-maintenance' .cmdline "$reset"
}

good="$base talos.config=$url"
profiles good "$good"
expect_pass good
expect_fail good other

profiles oauth "$good talos.config.oauth.client_id=example"
expect_fail oauth
profiles halt "$good talos.halt_if_installed=1"
expect_fail halt
profiles early "$good talos.config.early=https://example.invalid/early"
expect_fail early
profiles inline "$good talos.config.inline=Zm9v"
expect_fail inline
profiles twice "$good talos.config=https://example.invalid/other"
expect_fail twice
profiles old "$base talos.config=https://enroll.lolwtf.ca/config?uuid=\${uuid}&mac=\${mac}&serial=\${serial}"
expect_fail old
profiles none "$base"
expect_fail none

profiles reset-oauth "$good" "$good talos.config.oauth.client_id=example $wipe"
expect_fail reset-oauth
profiles reset-nowipe "$good" "$good"
expect_fail reset-nowipe
installer one-profile .cmdline "$good"
expect_fail one-profile

echo "talos-installer-verify: all cases pass"
