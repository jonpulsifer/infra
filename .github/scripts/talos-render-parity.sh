#!/usr/bin/env bash
# Renders each node of a Talos root twice from one throwaway secrets bundle:
# with the talos provider's talos_machine_configuration data source, as
# Atlantis does, and with talosctl gen config, as the enrollment server does.
# Fails on any byte difference. A node whose inputs tofu console cannot know
# without state, such as one installed from the Image Factory schematic, is
# skipped.
#
# usage: talos-render-parity.sh [root]   (default clusters/folly/talos)

set -euo pipefail

root=${1:-clusters/folly/talos}
work=$(mktemp -d)
override="$root/zz_render_parity_override.tf"
trap 'rm -rf "$work"; rm -f "$override"' EXIT

# The root's backend needs credentials; a local backend with no state lets
# tofu console evaluate the repo alone. The 1Password item is never opened.
printf 'terraform {\n  backend "local" {}\n}\n' >"$override"
export TF_DATA_DIR="$work/root-data" TF_IN_AUTOMATION=1
tofu -chdir="$root" init -input=false -lockfile=readonly >/dev/null

console() {
  printf '%s\n' "$1" | tofu -chdir="$root" console
}

inputs="$work/inputs.json"
echo '{}' >"$inputs"
nodes=$(console 'base64encode(jsonencode(keys(module.talos.machine_inputs)))' | tr -d '"' | base64 -d | jq -r '.[]')
for node in $nodes; do
  value=$(console "base64encode(jsonencode(module.talos.machine_inputs[\"$node\"]))")
  if [[ "$value" != \"*\" ]]; then
    echo "skip $node: its inputs are unknown without state"
    continue
  fi
  tr -d '"' <<<"$value" | base64 -d | jq --arg node "$node" --slurpfile all "$inputs" -n '$all[0] + {($node): input}' >"$work/next.json"
  mv "$work/next.json" "$inputs"
done
if [[ $(jq 'length' "$inputs") -eq 0 ]]; then
  echo "no node of $root has known inputs" >&2
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
    echo "ok $node: $(wc -c <"$work/$node.provider.yaml") bytes"
  else
    echo "MISMATCH $node: the provider and talosctl renders differ" >&2
    diff -u "$work/$node.provider.yaml" "$work/$node.talosctl.yaml" | head -n 80 >&2 || true
    failed=1
  fi
done

exit "$failed"
