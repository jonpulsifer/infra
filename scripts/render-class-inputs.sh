#!/usr/bin/env bash
# Writes the per-class render inputs fleet-controller renders from: the folly
# Talos root's class_inputs output, read by `tofu console` with no state and
# no 1Password. The control planes among them, which the API server's SANs
# name, are the declared ones NetBox holds active or failed, so this reads
# each node's status from NetBox, as the root does at plan time. A node adds
# nothing else here: the controller reads the node's facts from NetBox at
# render time.
#
# It also writes node-macs.json, the MACs NetBox holds for the declared nodes,
# which spore's nix/services/tinkerbell.nix reads for its netboot-not-allowed
# links.
#
# NetBox access is scripts/lib/netbox.sh's environment.
set -euo pipefail
shopt -s inherit_errexit

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly root
# shellcheck source=scripts/lib/netbox.sh
source "$root/scripts/lib/netbox.sh"
readonly fleet_dir="$root/clusters/folly/fleet"
readonly nodes_file="$root/clusters/folly/inventory/nodes.yaml"

nb_init
devices="$(nb_list "dcim/devices/?site=folly&role=kubernetes-node")"
interfaces="$(nb_list "dcim/interfaces/?type__n=virtual&$(jq -r 'map("device_id=\(.id)") | join("&")' <<<"$devices")")"
declared="$(yq -o json '.nodes | keys' "$nodes_file")"
statuses="$(jq -c 'map({key: .name, value: .status.value}) | from_entries' <<<"$devices")"
# As the Talos root's plan does, refuse a declared node NetBox has no device for.
missing="$(jq -rn --argjson s "$statuses" --argjson d "$declared" '$d - ($s | keys) | join(", ")')"
if [[ -n "$missing" ]]; then
  echo "no NetBox device for $missing in ${nodes_file#"$root"/}; apply terraform/netbox/folly first" >&2
  exit 1
fi

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
# The override's locals take each node's status from NetBox's answer above, so
# init and console never configure the NetBox provider.
cat >"$tf/render_override.tf" <<EOF
terraform {
  backend "local" {}
}

locals {
  machines = { for name, m in local.declared : name => merge(m, {
    status = jsondecode($(jq -R . <<<"$statuses"))[name]
  }) }
}
EOF

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

# Each declared node's MAC: its device's first interface with a primary MAC.
jq -S -n --argjson devices "$devices" --argjson interfaces "$interfaces" --argjson declared "$declared" '
  $devices
  | map(select(.name as $n | $declared | index($n)) | . as $d
    | ([$interfaces[] | select(.device.id == $d.id and .primary_mac_address != null)] | sort_by(.id) | first) as $nic
    | select($nic != null)
    | {key: $d.name, value: ($nic.primary_mac_address.mac_address | ascii_downcase)})
  | from_entries' >"$work/node-macs.json"

mv "$work/class-inputs.json" "$fleet_dir/class-inputs.json"
mv "$work/node-macs.json" "$fleet_dir/node-macs.json"
printf 'Wrote %s/class-inputs.json for: %s\n' "${fleet_dir#"$root"/}" "$(jq -r 'keys | join(", ")' "$fleet_dir/class-inputs.json")"
