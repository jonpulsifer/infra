#!/usr/bin/env bash
# Gives a service on a host its OpenBao AppRole secret ID: with the root token from 1Password
# 'openbao-forge', makes a secret ID for the role on forge, and stores it in the host's SOPS file as
# openbao/<role>-approle, an environment line the service's unit reads. openbao-config.service
# declares the role (homelab.openbao.pki.appRoles). Nothing secret reaches argv or stdout.
# docs/runbooks/configure-openbao-pki.md.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly root
# shellcheck source=scripts/yubikey.sh
source "$root/scripts/yubikey.sh"
readonly server_host="forge"
readonly cluster_item="openbao-forge"

usage() {
  echo "usage: $0 <role> <host>" >&2
  exit 2
}

main() {
  local role="${1:-}" host="${2:-}"
  [[ "$role" =~ ^[a-z][a-z0-9-]*$ ]] || usage
  [[ -n "$host" ]] || usage
  check_host "$host"
  need jq op sops ssh
  : "${SOPS_AGE_KEY_FILE:?set SOPS_AGE_KEY_FILE to the operator key}"

  local sops_file="$root/nix/secrets/$host.sops.yaml"
  local tgt
  tgt="$(target "$server_host")"
  make_work

  echo "==> reading the root token from 1Password '$cluster_item'" >&2
  op item get "$cluster_item" --vault "$op_vault" --fields label=root-token --reveal >"$work/root-token"
  [[ -s "$work/root-token" ]] || die "1Password '$cluster_item' holds no root-token"

  echo "==> making a secret ID for the AppRole $role on $tgt" >&2
  local dns_zone
  dns_zone="$(jq -er .locals.fleet.dns_zone "$root/terraform/network/tailscale/fleet.tf.json")"
  remote "$tgt" >"$work/secret-id" <<EOF
export BAO_ADDR="https://$server_host.$dns_zone:8200"
export BAO_TOKEN="$(cat "$work/root-token")"
bao read auth/approle/role/$role >/dev/null
bao write -field=secret_id auth/approle/role/$role/secret-id metadata='{"host":"$host"}'
EOF
  [[ -s "$work/secret-id" ]] || die "the server returned no secret ID; does openbao-config.service declare the role $role?"
  printf 'VAULT_APPROLE_SECRET_ID=%s\n' "$(cat "$work/secret-id")" >"$work/env"

  echo "==> storing it in ${sops_file#"$root/"} as openbao/$role-approle" >&2
  jq -Rs . <"$work/env" | sops set --value-stdin "$sops_file" "[\"openbao\"][\"$role-approle\"]"
  [[ "$(sops decrypt --extract "[\"openbao\"][\"$role-approle\"]" "$sops_file" | sha256sum)" == "$(sha256sum <"$work/env")" ]] \
    || die "${sops_file#"$root/"} does not hold the secret ID as created"

  cat >&2 <<EOF

Done: ${sops_file#"$root/"} holds the AppRole secret ID of $role for $host.
Commit it with the service's upstream option on in nix/hosts/$host.nix, then deploy $host.
EOF
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
