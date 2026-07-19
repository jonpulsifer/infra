#!/usr/bin/env bash

set -euo pipefail

script="$(dirname "$0")/validation-impact.sh"

assert_targets() {
  local name="$1" paths="$2" expected="$3" actual
  actual=$(printf '%s\n' "$paths" | "$script" targets)
  if [[ "$actual" != "$expected" ]]; then
    printf 'FAIL: %s\nexpected:\n%s\nactual:\n%s\n' "$name" "$expected" "$actual" >&2
    exit 1
  fi
}

assert_targets 'both topology ConfigMaps validate Nix' \
  $'clusters/folly/config/cluster-topology.json\nclusters/offsite/config/cluster-topology.json' \
  'nix:flake-check'

assert_targets 'the Nix workflow validates its routing target' \
  '.github/workflows/nix-ci.yaml' \
  'nix:flake-check'

assert_targets 'Spore application changes validate the direct Nix package' \
  'apps/spore/lib/catalog.ts' \
  'nix:flake-check'

assert_targets 'the Spore MAC source validates the generated Nix catalog' \
  'terraform/network/unifi/folly/clients.yaml' \
  $'nix:flake-check\nterraform:terraform/network/unifi/folly'

assert_targets 'the lab contract validates its Terraform root and Nix' \
  'terraform/network/unifi/folly/lab.tf.json' \
  $'nix:flake-check\nterraform:terraform/network/unifi/folly'

assert_targets 'a Terraform lockfile validates its owning root' \
  'terraform/network/unifi/offsite/.terraform.lock.hcl' \
  'terraform:terraform/network/unifi/offsite'

assert_targets 'a bootstrap Terraform file validates its bootstrap root' \
  'clusters/offsite/bootstrap/bootstrap.tf' \
  'terraform:clusters/offsite/bootstrap'

roots=$("$script" terraform-roots)
for root in clusters/folly/bootstrap clusters/offsite/bootstrap; do
  if ! grep -qxF "$root" <<< "$roots"; then
    printf 'FAIL: Terraform root list omits %s\n' "$root" >&2
    exit 1
  fi
done

if grep -qxF terraform/modules/gce-vpc <<< "$roots"; then
  echo 'FAIL: reusable Terraform modules are not validation roots' >&2
  exit 1
fi

script_targets=$(printf '%s\n' '.github/scripts/validation-impact.sh' | "$script" targets)
for root in clusters/folly/bootstrap clusters/offsite/bootstrap; do
  if ! grep -qxF "terraform:$root" <<< "$script_targets"; then
    printf 'FAIL: routing module changes do not validate %s\n' "$root" >&2
    exit 1
  fi
done
