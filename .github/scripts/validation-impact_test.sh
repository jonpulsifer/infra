#!/usr/bin/env bash

set -euo pipefail

script="$(cd "$(dirname "$0")" && pwd)/validation-impact.sh"

# Routes paths from the repository root, or from an optional fixture tree.
assert_targets() {
  local name="$1" paths="$2" expected="$3" tree="${4:-.}" actual
  actual=$(cd "$tree" && printf '%s\n' "$paths" | "$script" targets)
  if [[ "$actual" != "$expected" ]]; then
    printf 'FAIL: %s\nexpected:\n%s\nactual:\n%s\n' "$name" "$expected" "$actual" >&2
    exit 1
  fi
}

assert_targets 'both topology ConfigMaps validate Nix' \
  $'clusters/folly/config/cluster-topology.json\nclusters/offsite/config/cluster-topology.json' \
  'nix:flake-check'

assert_targets 'every path routes when changed-files escapes the separators' \
  $'clusters/folly/config/cluster-topology.json\\\nterraform/network/unifi/offsite/k8s.tf\\\nterraform/network/tailscale/devices.tf' \
  $'nix:flake-check\nterraform:terraform/network/tailscale\nterraform:terraform/network/unifi/offsite'

assert_targets 'the Nix workflow validates its routing target' \
  '.github/workflows/nix-ci.yaml' \
  'nix:flake-check'

assert_targets 'the retired Spore application has no Nix validation route' \
  'apps/spore/lib/catalog.ts' \
  ''

assert_targets 'the DHCP reservation source validates its Terraform root' \
  'terraform/network/unifi/folly/clients.yaml' \
  'terraform:terraform/network/unifi/folly'

assert_targets 'the lab topology ConfigMap validates Terraform and Nix consumers' \
  'clusters/folly/config/lab-topology.json' \
  $'nix:flake-check\nterraform:terraform/network/unifi/folly'

assert_targets 'the removed Terraform JSON has no stale route' \
  'terraform/network/unifi/folly/lab.tf.json' \
  ''

assert_targets 'a Terraform lockfile validates its owning root' \
  'terraform/network/unifi/offsite/.terraform.lock.hcl' \
  'terraform:terraform/network/unifi/offsite'

assert_targets 'a bootstrap Terraform file validates its bootstrap root' \
  'clusters/offsite/bootstrap/bootstrap.tf' \
  'terraform:clusters/offsite/bootstrap'

assert_targets 'a Terraform test file validates its root' \
  'clusters/folly/bootstrap/bootstrap.tftest.hcl' \
  'terraform:clusters/folly/bootstrap'

roots=$("$script" terraform-roots)
for root in clusters/folly/bootstrap clusters/offsite/bootstrap; do
  if ! grep -qxF "$root" <<<"$roots"; then
    printf 'FAIL: Terraform root list omits %s\n' "$root" >&2
    exit 1
  fi
done

if grep -qxF terraform/modules/gce-vpc <<<"$roots"; then
  echo 'FAIL: reusable Terraform modules are not validation roots' >&2
  exit 1
fi

script_targets=$(printf '%s\n' '.github/scripts/validation-impact.sh' | "$script" targets)
for root in clusters/folly/bootstrap clusters/offsite/bootstrap; do
  if ! grep -qxF "terraform:$root" <<<"$script_targets"; then
    printf 'FAIL: routing module changes do not validate %s\n' "$root" >&2
    exit 1
  fi
done

# A Talos root under clusters/<site>/talos is a validation root, and its
# site's topology ConfigMap validates it. No such root exists yet, so a
# fixture tree with one for folly stands in for the repository.
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
mkdir -p "$fixture"/clusters/{folly,offsite}/{bootstrap,config} \
  "$fixture/clusters/folly/talos" "$fixture/terraform/modules/talos-cluster"
for root in clusters/folly/bootstrap clusters/offsite/bootstrap clusters/folly/talos; do
  printf 'terraform {\n  backend "gcs" {}\n}\n' >"$fixture/$root/main.tf"
done
touch "$fixture/terraform/modules/talos-cluster/main.tf" \
  "$fixture"/clusters/{folly,offsite}/config/cluster-topology.json

fixture_roots=$(cd "$fixture" && "$script" terraform-roots)
if ! grep -qxF clusters/folly/talos <<<"$fixture_roots"; then
  echo 'FAIL: Terraform root list omits a Talos root' >&2
  exit 1
fi
if grep -qxF clusters/offsite/talos <<<"$fixture_roots"; then
  echo 'FAIL: Terraform root list names a Talos root that does not exist' >&2
  exit 1
fi

assert_targets 'a Talos root file validates its Talos root' \
  'clusters/folly/talos/talos.tf' \
  'terraform:clusters/folly/talos' "$fixture"

assert_targets 'the topology ConfigMap validates its Talos root once that root exists' \
  'clusters/folly/config/cluster-topology.json' \
  $'nix:flake-check\nterraform:clusters/folly/talos' "$fixture"

assert_targets 'the topology ConfigMap of a site without a Talos root validates Nix alone' \
  'clusters/offsite/config/cluster-topology.json' \
  'nix:flake-check' "$fixture"

fixture_script_targets=$(cd "$fixture" && printf '%s\n' '.github/scripts/validation-impact.sh' | "$script" targets)
if ! grep -qxF 'terraform:clusters/folly/talos' <<<"$fixture_script_targets"; then
  echo 'FAIL: routing module changes do not validate a Talos root' >&2
  exit 1
fi
