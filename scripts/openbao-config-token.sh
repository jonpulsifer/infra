#!/usr/bin/env bash
# Gives openbao-config.service on an anchor its token: with the root token from 1Password
# 'openbao-forge', writes the openbao-config policy and makes a periodic orphan token with it on
# the anchor, and stores the token in the host's SOPS file as openbao/config-token. Nothing secret
# reaches argv or stdout. docs/runbooks/sign-the-issuing-ca.md.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly root
# shellcheck source=scripts/yubikey.sh
source "$root/scripts/yubikey.sh"
readonly policy_file="$root/nix/services/openbao/config-policy.hcl"
readonly cluster_item="openbao-forge"
readonly token_period="720h"

usage() {
  echo "usage: $0 <host>" >&2
  exit 2
}

main() {
  local host="${1:-}"
  [[ -n "$host" ]] || usage
  check_host "$host"
  need jq op sops ssh
  : "${SOPS_AGE_KEY_FILE:?set SOPS_AGE_KEY_FILE to the operator key}"

  local sops_file="$root/nix/secrets/$host.sops.yaml"
  local tgt
  tgt="$(target "$host")"
  make_work

  echo "==> reading the root token from 1Password '$cluster_item'" >&2
  op item get "$cluster_item" --vault "$op_vault" --fields label=root-token --reveal >"$work/root-token"
  [[ -s "$work/root-token" ]] || die "1Password '$cluster_item' holds no root-token"

  echo "==> writing the openbao-config policy and a $token_period periodic token on $tgt" >&2
  local dns_zone
  dns_zone="$(jq -er .locals.fleet.dns_zone "$root/terraform/network/tailscale/fleet.tf.json")"
  remote "$tgt" >"$work/token" <<EOF
export BAO_ADDR="https://$host.$dns_zone:8200"
export BAO_TOKEN="$(cat "$work/root-token")"
bao policy write openbao-config - >&2 <<'HCL'
$(cat "$policy_file")
HCL
bao token create -policy=openbao-config -period=$token_period -orphan -display-name=openbao-config -field=token
EOF
  [[ -s "$work/token" ]] || die "the anchor returned no token"

  echo "==> storing it in ${sops_file#"$root/"} as openbao/config-token" >&2
  jq -Rs . <"$work/token" | sops set --value-stdin "$sops_file" '["openbao"]["config-token"]'
  [[ "$(sops decrypt --extract '["openbao"]["config-token"]' "$sops_file" | sha256sum)" == "$(sha256sum <"$work/token")" ]] \
    || die "${sops_file#"$root/"} does not hold the token as created"

  cat >&2 <<EOF

Done: ${sops_file#"$root/"} holds the token of openbao-config.service on $host.
Commit it with homelab.openbao.pki.enable = true in nix/hosts/$host.nix, then deploy $host.
EOF
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
