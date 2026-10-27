#!/usr/bin/env bash
# Writes each folly node's MAC, address and install disk, and the HookOS UKI's URL and command line, to the env file
# that clusters/folly/tinkerbell/ reads through kustomize replacements. Sources: the UniFi client list,
# NODE_ADDRESSES, the folly Talos root's install selectors and SPORE_BOOTSTRAP_IP. With --check it
# fails if the committed file differs or a placeholder survives the build.
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
macs="$(yq -o json '.k8s | map_values(.mac)' "$root/terraform/network/unifi/folly/clients.yaml")"
spore="$(jq -er '.data.SPORE_BOOTSTRAP_IP' "$root/clusters/folly/config/lab-topology.json")"
agent="$(jq -er '.tink_agent_image' "$root/clusters/folly/talos/netboot.json")"

# Each node's `install = "disk.dev_path == \"<path>\""` in local.nodes, keyed by the block it is in.
block='^[[:space:]]*([a-z0-9-]+)[[:space:]]*=[[:space:]]*\{'
install='install[[:space:]]*=[[:space:]]*"disk\.dev_path == \\"(/dev/[^\\]+)\\""'
disks="$(
  node=""
  while IFS= read -r line; do
    if [[ "$line" =~ $block ]]; then node="${BASH_REMATCH[1]}"; fi
    if [[ "$line" =~ $install ]]; then printf '%s\t%s\n' "$node" "${BASH_REMATCH[1]}"; fi
  done <"$root/clusters/folly/talos/talos.tf" | jq -Rn '[inputs | split("\t") | {(.[0]): .[1]}] | add // {}'
)"

rendered="$(
  echo "# Written by mise run render-tinkerbell-nodes from the UniFi client list, NODE_ADDRESSES, the Talos"
  echo "# install selectors and SPORE_BOOTSTRAP_IP."
  echo "HOOKOS_URL=http://$spore/talos/folly/hookos-amd64-secureboot-uki.efi"
  # The command line nix/images/hookos-folly.nix bakes into the UKI. Without Secure Boot,
  # systemd-stub takes iPXE's arguments instead, so the per-MAC script passes the same one.
  echo "HOOKOS_CMDLINE=facility= syslog_host=$spore grpc_authority=$spore:42113 tinkerbell_tls=false tinkerbell_insecure_tls=false modules=loop,squashfs,sd-mod,usb-storage intel_iommu=on iommu=pt console=ttyS0,115200 console=tty0 tink_worker_image=$agent"
  jq -nr --argjson addresses "$addresses" --argjson macs "$macs" --argjson disks "$disks" '
    $addresses | keys[] as $node
    | ($node | ascii_upcase | gsub("-"; "_")) as $key
    | ($macs[$node] // error("terraform/network/unifi/folly/clients.yaml has no k8s MAC for \($node)")) as $mac
    | ($disks[$node] // error("clusters/folly/talos/talos.tf has no disk.dev_path install selector for \($node)")) as $disk
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
