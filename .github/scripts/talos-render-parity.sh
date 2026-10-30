#!/usr/bin/env bash
# Renders each node of a Talos root three ways from one throwaway secrets
# bundle and fails on any byte difference:
#   1. the talos provider's talos_machine_configuration data source, as
#      Atlantis does, from the module's install_inputs;
#   2. talosctl gen config from the same inputs;
#   3. fleetd's class render (apps/fleetd/fleet: class inputs
#      plus the node document it writes from the node's facts), which writes
#      the config an install fetches, through its TestRenderParity, which also
#      proves the throwaway-bundle worker render.
# It also fails when the committed class-inputs.json is stale against the
# root. A node whose inputs tofu console cannot know without state is skipped.
#
# Every declared node is taken as active, since CI cannot read NetBox, so the
# committed class inputs must be rendered while NetBox holds every declared
# control plane active. Beside the declared nodes, the root is evaluated with one more machine,
# joining-cp, a control plane at a documentation address, twice. Planned, as a
# control plane that fleetd installs is until it fetches its config,
# the root applies no config to it and the committed class inputs stay current.
# Active, the root takes it as a second control plane that joins the cluster
# (talos_machine.joining), and every node is compared from the root's inputs
# and the class inputs it renders then, as mise run render-class-inputs writes
# them once NetBox holds it active.
#
# usage: talos-render-parity.sh [root]   (default clusters/folly/talos)

set -euo pipefail

root=${1:-clusters/folly/talos}
site=$(basename "$(dirname "$root")")
work=$(mktemp -d)
override="$root/zz_render_parity_override.tf"
trap 'rm -rf "$work"; rm -f "$override"' EXIT

# The root's backend needs credentials; a local backend with no state lets
# tofu console evaluate the repo alone. The 1Password item is never opened.
# The override's locals add joining-cp with the status given.
cp_class=$(jq -r '[to_entries[] | select(.value.machine_type == "controlplane") | .key] | first // empty' "clusters/$site/fleet/class-inputs.json")
if [[ -z "$cp_class" ]]; then
  echo "clusters/$site/fleet/class-inputs.json has no control-plane class" >&2
  exit 1
fi
joining() {
  cat >"$override" <<EOF
terraform {
  backend "local" {}
}

locals {
  machines = merge({ for name, m in local.declared : name => merge(m, { status = "active" }) }, {
    joining-cp = { class = "$cp_class", status = "$1", address = "192.0.2.10", disk = "/dev/nvme0n1", tpm = "2.0" }
  })
}
EOF
}
joining planned
export TF_DATA_DIR="$work/root-data" TF_IN_AUTOMATION=1
tofu -chdir="$root" init -input=false -lockfile=readonly >/dev/null

console() {
  printf '%s\n' "$1" | tofu -chdir="$root" console
}

decode() {
  tr -d '"' | base64 -d
}

if [[ $(console 'contains(keys(local.nodes), "joining-cp")') != false ]]; then
  echo "the root applies config to a planned control plane" >&2
  exit 1
fi

# The committed class inputs must be what the root renders now, a planned
# control plane beside the inventory changing nothing.
class_inputs="clusters/$site/fleet/class-inputs.json"
console 'base64encode(jsonencode(local.class_inputs))' | decode | jq -S . >"$work/class-inputs.json"
if ! cmp -s "$work/class-inputs.json" "$class_inputs"; then
  echo "STALE $class_inputs: run mise run render-class-inputs and commit" >&2
  diff -u "$class_inputs" "$work/class-inputs.json" | head -n 40 >&2 || true
  exit 1
fi
echo "ok $class_inputs is current"

# From here joining-cp is active: a second control plane that joins.
joining active
if [[ $(console 'local.nodes["joining-cp"].role == "controlplane" && local.machines["joining-cp"].address != module.topology.data.API_SERVER_IP') != true ]]; then
  echo "the root does not take an active joining-cp as a joining control plane" >&2
  exit 1
fi
console 'base64encode(jsonencode(local.class_inputs))' | decode | jq -S . >"$work/class-inputs-joining.json"

inputs="$work/inputs.json"
echo '{}' >"$inputs"
nodes=$(console 'base64encode(jsonencode(keys(module.talos.install_inputs)))' | decode | jq -r '.[]')
for node in $nodes; do
  value=$(console "base64encode(jsonencode(module.talos.install_inputs[\"$node\"]))")
  if [[ "$value" != \"*\" ]]; then
    echo "skip $node: its inputs are unknown without state"
    continue
  fi
  decode <<<"$value" | jq --arg node "$node" --slurpfile all "$inputs" -n '$all[0] + {($node): input}' >"$work/next.json"
  mv "$work/next.json" "$inputs"
done
if [[ $(jq 'length' "$inputs") -eq 0 ]]; then
  echo "no node of $root has known inputs" >&2
  exit 1
fi
if ! jq -e 'has("joining-cp")' "$inputs" >/dev/null; then
  echo "the root has no inputs for joining-cp" >&2
  exit 1
fi

# The node facts the controller reads from NetBox, from the nodes file
# as the root decodes it, beside the module's inputs for the same node.
console 'base64encode(jsonencode({ for n, m in local.machines : n => { class = m.class, disk = m.disk, tpm = m.tpm, address = m.address } }))' \
  | decode | jq --slurpfile all "$inputs" 'with_entries(select(.key as $k | $all[0] | has($k)))' >"$work/nodes.json"
if [[ $(jq '[.[] | select(.class == null)] | length' "$work/nodes.json") -ne 0 ]]; then
  echo "a node of $root has no class in clusters/$site/inventory/nodes.yaml" >&2
  exit 1
fi

talosctl gen secrets -o "$work/secrets.yaml" >/dev/null

# The provider render, with the root's provider lock.
render="$work/render"
mkdir -p "$render"
cp "$root/.terraform.lock.hcl" "$render/"
cat >"$render/main.tf" <<'EOF'
terraform {
  required_providers {
    talos = {
      source = "siderolabs/talos"
    }
  }
}

variable "inputs_file" {
  type = string
}

variable "secrets_file" {
  type = string
}

locals {
  inputs = jsondecode(file(var.inputs_file))
  bundle = yamldecode(file(var.secrets_file))
}

data "talos_machine_configuration" "node" {
  for_each = local.inputs

  cluster_name       = each.value.cluster_name
  cluster_endpoint   = each.value.cluster_endpoint
  machine_type       = each.value.machine_type
  talos_version      = each.value.talos_contract
  kubernetes_version = each.value.kubernetes_version
  config_patches     = each.value.config_patches
  docs               = false
  examples           = false
  machine_secrets = {
    cluster = {
      id     = local.bundle.cluster.id
      secret = local.bundle.cluster.secret
    }
    secrets = {
      bootstrap_token             = local.bundle.secrets.bootstraptoken
      secretbox_encryption_secret = local.bundle.secrets.secretboxencryptionsecret
    }
    trustdinfo = {
      token = local.bundle.trustdinfo.token
    }
    certs = {
      etcd               = { cert = local.bundle.certs.etcd.crt, key = local.bundle.certs.etcd.key }
      k8s                = { cert = local.bundle.certs.k8s.crt, key = local.bundle.certs.k8s.key }
      k8s_aggregator     = { cert = local.bundle.certs.k8saggregator.crt, key = local.bundle.certs.k8saggregator.key }
      k8s_serviceaccount = { key = local.bundle.certs.k8sserviceaccount.key }
      os                 = { cert = local.bundle.certs.os.crt, key = local.bundle.certs.os.key }
    }
  }
}

output "configs" {
  value     = { for name, c in data.talos_machine_configuration.node : name => c.machine_configuration }
  sensitive = true
}
EOF
export TF_DATA_DIR="$work/render-data"
tofu -chdir="$render" init -input=false >/dev/null
tofu -chdir="$render" apply -input=false -auto-approve \
  -var "inputs_file=$inputs" -var "secrets_file=$work/secrets.yaml" >/dev/null
tofu -chdir="$render" output -json configs >"$work/provider.json"

failed=0
for node in $(jq -r 'keys[]' "$inputs"); do
  jq -j --arg node "$node" '.[$node]' "$work/provider.json" >"$work/$node.provider.yaml"

  type=$(jq -r --arg node "$node" '.[$node].machine_type' "$inputs")
  flag=--config-patch-worker
  [[ "$type" == controlplane ]] && flag=--config-patch-control-plane
  args=()
  count=$(jq --arg node "$node" '.[$node].config_patches | length' "$inputs")
  for ((i = 0; i < count; i++)); do
    jq -j --arg node "$node" --argjson i "$i" '.[$node].config_patches[$i]' "$inputs" >"$work/$node.patch.$i.yaml"
    args+=("$flag" "@$work/$node.patch.$i.yaml")
  done

  jq -r --arg node "$node" '.[$node] | .cluster_name, .cluster_endpoint, .talos_contract, .kubernetes_version' "$inputs" | {
    read -r name
    read -r endpoint
    read -r contract
    read -r kubernetes
    talosctl gen config "$name" "$endpoint" \
      --with-secrets "$work/secrets.yaml" \
      --talos-version "$contract" \
      --kubernetes-version "$kubernetes" \
      --with-docs=false --with-examples=false \
      --output-types "$type" --output - \
      "${args[@]}" >"$work/$node.talosctl.yaml"
  }

  if cmp -s "$work/$node.provider.yaml" "$work/$node.talosctl.yaml"; then
    echo "ok $node: provider and talosctl agree, $(wc -c <"$work/$node.provider.yaml") bytes"
  else
    echo "MISMATCH $node: the provider and talosctl renders differ" >&2
    diff -u "$work/$node.provider.yaml" "$work/$node.talosctl.yaml" | head -n 80 >&2 || true
    failed=1
  fi
done

# fleetd's render of each node, against the module's, from the
# class inputs the root renders with joining-cp active.
FLEET_PARITY_INPUTS="$inputs" FLEET_PARITY_NODES="$work/nodes.json" \
  FLEET_CLASS_INPUTS="$work/class-inputs-joining.json" FLEET_PARITY_BUNDLE="$work/secrets.yaml" \
  go test -C apps/fleetd -count=1 -run 'TestRenderParity|TestTalosctlRender' -v ./fleet/ || failed=1

exit "$failed"
