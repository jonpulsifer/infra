#!/usr/bin/env bash
# Writes the per-class render inputs fleet-controller renders from: the folly
# Talos root's class_inputs output, read by `tofu console` with no state and
# no 1Password. A node adds nothing here: the controller reads the node's facts
# from NetBox at render time.
#
# It also writes node-macs.json, the inventory's MACs, which spore's
# nix/services/tinkerbell.nix reads for its netboot-not-allowed links.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly root
readonly out="$root/clusters/folly/fleet"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
tf="$work/clusters/folly/talos"

# A copy of the root whose backend is local, so init never reaches the GCS
# state. The links keep every relative path the root and modules read.
mkdir -p "$tf"
cp "$root"/clusters/folly/talos/*.tf "$root/clusters/folly/talos/.terraform.lock.hcl" "$tf/"
ln -s "$root/terraform" "$work/terraform"
ln -s "$root/clusters/folly/config" "$work/clusters/folly/config"
ln -s "$root/clusters/folly/inventory" "$work/clusters/folly/inventory"
printf 'terraform {\n  backend "local" {}\n}\n' >"$tf/render_override.tf"

tofu -chdir="$tf" init -input=false -no-color >"$work/init.log" 2>&1 || {
  cat "$work/init.log" >&2
  exit 1
}

# console prints the value as an HCL string; base64 keeps it on one line.
value="$(echo "base64encode(jsonencode(local.class_inputs))" | tofu -chdir="$tf" console -no-color)"
value="${value#\"}"
value="${value%\"}"
[[ "$value" =~ ^[A-Za-z0-9+/=]+$ ]] || {
  echo "local.class_inputs does not evaluate without state" >&2
  exit 1
}
base64 -d <<<"$value" | jq -S . >"$work/class-inputs.json"

yq -o json '.machines | map_values(.mac)' "$root/clusters/folly/inventory/machines.yaml" \
  | jq -S . >"$work/node-macs.json"

mv "$work/class-inputs.json" "$out/class-inputs.json"
mv "$work/node-macs.json" "$out/node-macs.json"
printf 'Wrote %s/class-inputs.json for: %s\n' "${out#"$root"/}" "$(jq -r 'keys | join(", ")' "$out/class-inputs.json")"
