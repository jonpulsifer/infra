#!/usr/bin/env bash
# Writes each folly node's MAC, address and install disk, and the HookOS UKI's URL and command line, to the env file
# that clusters/folly/tinkerbell/ reads through kustomize replacements. Sources: the hardware inventory,
# NODE_ADDRESSES and SPORE_BOOTSTRAP_IP. With --check it fails if the committed file differs or a placeholder
# survives the build.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly root
readonly out="$root/clusters/folly/tinkerbell/nodes.env"

check=false
case "${1:-}" in
  --check) check=true ;;
  "") ;;
  *)
    echo "usage: $0 [--check]" >&2
    exit 64
    ;;
esac

addresses="$(jq -er '.data.NODE_ADDRESSES | fromjson' "$root/clusters/folly/config/cluster-topology.json")"
machines="$(yq -o json '.machines' "$root/clusters/folly/inventory/machines.yaml")"
spore="$(jq -er '.data.SPORE_BOOTSTRAP_IP' "$root/clusters/folly/config/lab-topology.json")"
agent="$(jq -er '.tink_agent_image' "$root/clusters/folly/talos/netboot.json")"

rendered="$(
  echo "# Written by mise run render-tinkerbell-nodes from the hardware inventory, NODE_ADDRESSES and"
  echo "# SPORE_BOOTSTRAP_IP."
  echo "HOOKOS_URL=http://$spore/talos/folly/hookos-amd64-secureboot-uki.efi"
  # The command line nix/images/hookos-folly.nix bakes into the UKI. Without Secure Boot,
  # systemd-stub takes iPXE's arguments instead, so the per-MAC script passes the same one.
  echo "HOOKOS_CMDLINE=facility= syslog_host=$spore grpc_authority=$spore:42113 tinkerbell_tls=false tinkerbell_insecure_tls=false modules=loop,squashfs,sd-mod,usb-storage intel_iommu=on iommu=pt console=ttyS0,115200 console=tty0 tink_worker_image=$agent"
  jq -nr --argjson addresses "$addresses" --argjson machines "$machines" '
    $addresses | keys[] as $node
    | ($node | ascii_upcase | gsub("-"; "_")) as $key
    | ($machines[$node] // error("clusters/folly/inventory/machines.yaml has no entry for \($node)")) as $m
    | ($m.mac // error("no mac for \($node) in the inventory")) as $mac
    | ($m.disk // error("no disk for \($node) in the inventory")) as $disk
    | "\($key)_MAC=\($mac | ascii_downcase)", "\($key)_ADDRESS=\($addresses[$node])", "\($key)_DISK=\($disk)"
  '
)"

if [[ "$check" == true ]]; then
  if ! diff -u "$out" - <<<"$rendered"; then
    echo "${out#"$root"/} is stale; run mise run render-tinkerbell-nodes" >&2
    exit 1
  fi
  # A replacement whose target was renamed matches nothing, and kustomize does not fail.
  if kubectl kustomize "$(dirname "$out")" | grep -n 'from-nodes-env'; then
    echo "a placeholder above survives the build; fix the replacements in $(dirname "${out#"$root"/}")/kustomization.yaml" >&2
    exit 1
  fi
  exit 0
fi

printf '%s\n' "$rendered" >"$out"
echo "wrote ${out#"$root"/}"
