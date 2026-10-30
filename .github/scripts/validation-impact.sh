#!/usr/bin/env bash
# Maps changed paths on stdin to validation targets, one per line on stdout.

set -euo pipefail

usage() {
  echo "usage: $0 {targets|terraform-roots}" >&2
  exit 64
}

terraform_root_for_path() {
  local path="$1" directory
  directory=$(dirname "$path")

  while [[ "$directory" != "." && "$directory" != "/" ]]; do
    if compgen -G "$directory/*.tf" >/dev/null; then
      printf 'terraform:%s\n' "$directory"
      return
    fi
    directory=$(dirname "$directory")
  done
}

targets() {
  local path root
  declare -A target_set=()

  while IFS= read -r path; do
    # tj-actions' safe_output leaves a trailing backslash on every path but the
    # last, which no pattern below matches.
    path=${path%\\}
    [[ -n "$path" ]] || continue
    case "$path" in
      flake.nix | flake.lock | nix/* | apps/ddnsd/* | apps/fleetd/* | clusters/folly/config/cluster-topology.json | clusters/offsite/config/cluster-topology.json | clusters/folly/config/anchor-topology.json | .github/workflows/nix-ci.yaml)
        target_set["nix:flake-check"]=1
        ;;
      # spore mirrors the Talos release that talos.tf names and checks it against the committed certs,
      # and the HookOS package reads netboot.json.
      clusters/folly/talos/talos.tf | clusters/folly/talos/netboot.json | clusters/folly/talos/secureboot/* | .github/scripts/talos-uki-verify.sh)
        target_set["nix:flake-check"]=1
        ;;
      # spore's SPIRE node aliases and fleetd's inventory read the nodes file.
      clusters/folly/inventory/nodes.yaml)
        target_set["nix:flake-check"]=1
        ;;
    esac

    case "$path" in
      .github/scripts/validation-impact.sh | .github/workflows/terraform.yml)
        while IFS= read -r root; do
          target_set["terraform:$root"]=1
        done < <(terraform_roots)
        ;;
      clusters/folly/config/anchor-topology.json)
        target_set["terraform:terraform/network/unifi/folly"]=1
        target_set["terraform:terraform/netbox/folly"]=1
        ;;
      terraform/network/unifi/folly/clients.yaml)
        target_set["terraform:terraform/network/unifi/folly"]=1
        ;;
      clusters/folly/inventory/nodes.yaml)
        target_set["terraform:terraform/netbox/folly"]=1
        target_set["terraform:terraform/network/unifi/folly"]=1
        target_set["terraform:clusters/folly/talos"]=1
        ;;
      clusters/*/config/cluster-topology.json)
        # The site's Talos root reads this file, once that root exists.
        root="clusters/$(cut -d/ -f2 <<<"$path")/talos"
        compgen -G "$root/*.tf" >/dev/null && target_set["terraform:$root"]=1
        # folly's NetBox root reads its node prefix and API server address.
        if [[ "$path" == clusters/folly/* ]] && compgen -G "terraform/netbox/folly/*.tf" >/dev/null; then
          target_set["terraform:terraform/netbox/folly"]=1
        fi
        ;;
      *.tf | *.tftest.hcl | */.terraform.lock.hcl)
        target=$(terraform_root_for_path "$path" || true)
        [[ -n "${target:-}" ]] && target_set["$target"]=1
        ;;
    esac
  done

  printf '%s\n' "${!target_set[@]}" | sort
}

terraform_roots() {
  # A backend block marks a root; modules have none. nullglob drops a root
  # family that has no directory yet, such as clusters/*/talos.
  local -a families
  shopt -s nullglob
  families=(terraform clusters/*/bootstrap clusters/*/talos)
  shopt -u nullglob
  grep -rl --include='*.tf' 'backend "' "${families[@]}" | xargs -r -n1 dirname | sort -u
}

case "${1:-}" in
  targets) targets ;;
  terraform-roots) terraform_roots ;;
  *) usage ;;
esac
