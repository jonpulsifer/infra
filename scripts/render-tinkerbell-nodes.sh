#!/usr/bin/env bash
# Writes the MAC and address of each folly node into the env file that the Tinkerbell objects in
# clusters/folly/tinkerbell/ read through kustomize replacements. MACs come from the UniFi client
# list and addresses from NODE_ADDRESSES. With --check it fails if the committed file differs or a
# placeholder survives the build.
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

rendered="$(
  echo "# Written by mise run render-tinkerbell-nodes from the UniFi client list and NODE_ADDRESSES."
  jq -nr --argjson addresses "$addresses" --argjson macs "$macs" '
    $addresses | keys[] as $node
    | ($node | ascii_upcase | gsub("-"; "_")) as $key
    | ($macs[$node] // error("terraform/network/unifi/folly/clients.yaml has no k8s MAC for \($node)")) as $mac
    | "\($key)_MAC=\($mac | ascii_downcase)", "\($key)_ADDRESS=\($addresses[$node])"
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
