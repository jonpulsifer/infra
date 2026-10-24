#!/usr/bin/env bash
# Writes the per-node render inputs that talos-enroll serves from: the folly
# Talos root's machine_inputs output, read by `tofu console` with no state and
# no 1Password, and each node's MAC from the UniFi client list as a hint.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly root
readonly out="$root/clusters/folly/apps/talos-enroll"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
tf="$work/clusters/folly/talos"

# A copy of the root whose backend is local, so init never reaches the GCS
# state. The links keep every relative path the root and modules read.
mkdir -p "$tf"
cp "$root"/clusters/folly/talos/*.tf "$root/clusters/folly/talos/.terraform.lock.hcl" "$tf/"
ln -s "$root/terraform" "$work/terraform"
ln -s "$root/clusters/folly/config" "$work/clusters/folly/config"
printf 'terraform {\n  backend "local" {}\n}\n' >"$tf/render_override.tf"

tofu -chdir="$tf" init -input=false -no-color >"$work/init.log" 2>&1 || {
  cat "$work/init.log" >&2
  exit 1
}

# console prints each value as an HCL string; base64 keeps it on one line.
evaluate() {
  local value
  value="$(echo "base64encode(jsonencode($1))" | tofu -chdir="$tf" console -no-color)"
  value="${value#\"}"
  value="${value%\"}"
  [[ "$value" =~ ^[A-Za-z0-9+/=]+$ ]] || return 1
  base64 -d <<<"$value"
}

nodes="$(evaluate 'keys(module.talos.machine_inputs)')" || {
  echo "module.talos.machine_inputs does not evaluate without state" >&2
  exit 1
}
echo '{}' >"$work/machine-inputs.json"
for node in $(jq -r '.[]' <<<"$nodes"); do
  # A node whose installer image comes from the Image Factory resource is
  # unknown without state, and talos-enroll must not render it.
  if ! inputs="$(evaluate "module.talos.machine_inputs[\"$node\"]")"; then
    printf 'skip %s: its inputs are not known without state\n' "$node" >&2
    continue
  fi
  jq -S --arg node "$node" --argjson inputs "$inputs" '.[$node] = $inputs' \
    "$work/machine-inputs.json" >"$work/next.json"
  mv "$work/next.json" "$work/machine-inputs.json"
done

yq -o json '.k8s | map_values(.mac)' "$root/terraform/network/unifi/folly/clients.yaml" \
  | jq -S --slurpfile inputs "$work/machine-inputs.json" \
    'with_entries(select(.key as $k | $inputs[0] | has($k)))' >"$work/node-macs.json"

mv "$work/machine-inputs.json" "$out/machine-inputs.json"
mv "$work/node-macs.json" "$out/node-macs.json"
printf 'Wrote %s for: %s\n' "${out#"$root"/}" "$(jq -r 'keys | join(", ")' "$out/machine-inputs.json")"
