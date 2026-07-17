#!/usr/bin/env bash
# Maps changed repository paths to the existing validation targets that own
# their meaning. This is deliberately the public seam: callers supply paths
# on stdin and consume one stable target per line on stdout.

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
  local path
  declare -A target_set=()

  while IFS= read -r path; do
    [[ -n "$path" ]] || continue
    case "$path" in
      flake.nix|flake.lock|nix/*|apps/ddnsd/*|dotfiles/*|clusters/folly/config/cluster-topology.json|clusters/offsite/config/cluster-topology.json|terraform/network/unifi/folly/lab.tf.json)
        target_set[nix:flake-check]=1
        ;;
    esac

    case "$path" in
      .github/scripts/validation-impact.sh)
        while IFS= read -r root; do
          target_set["terraform:$root"]=1
        done < <(terraform_roots)
        ;;
      terraform/network/unifi/folly/lab.tf.json)
        target_set[terraform:terraform/network/unifi/folly]=1
        ;;
      *.tf|*/.terraform.lock.hcl)
        target=$(terraform_root_for_path "$path" || true)
        [[ -n "${target:-}" ]] && target_set["$target"]=1
        ;;
    esac
  done

  printf '%s\n' "${!target_set[@]}" | sort
}

terraform_roots() {
  # A backend declaration distinguishes independently validated roots from
  # reusable modules beneath terraform/modules.
  rg -l --glob '*.tf' 'backend "' terraform clusters/*/bootstrap | xargs -r -n1 dirname | sort -u
}

case "${1:-}" in
  targets) targets ;;
  terraform-roots) terraform_roots ;;
  *) usage ;;
esac
