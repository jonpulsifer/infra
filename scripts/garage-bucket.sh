#!/usr/bin/env bash
# Adds a bucket to folly's Garage with a key of its own: makes the key, escrows it in the 1Password
# item garage-folly, stores it in the host's SOPS file as garage/keys/<name>/{id,secret}, and on the
# anchor imports the key, creates the bucket and grants the key and the push key. Idempotent on the
# anchor. nix/services/garage.nix lists the same buckets and keys for a bootstrap. Nothing secret
# reaches argv or stdout. docs/platform/backups.md.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly root
# shellcheck source=scripts/yubikey.sh
source "$root/scripts/yubikey.sh"
readonly item="garage-folly"
readonly garage="env GARAGE_CONFIG_FILE=/etc/garage.toml garage"

usage() {
  echo "usage: $0 <name> <host>   (the bucket and key name, and the anchor whose SOPS file gets the key)" >&2
  exit 2
}

main() {
  local name="${1:-}" host="${2:-}"
  [[ "$name" =~ ^[a-z][a-z0-9-]*$ ]] || usage
  [[ -n "$host" ]] || usage
  check_host "$host"
  need jq op sops ssh od
  : "${SOPS_AGE_KEY_FILE:?set SOPS_AGE_KEY_FILE to the operator key}"

  local sops_file="$root/nix/secrets/$host.sops.yaml"
  local tgt
  tgt="$(target "$host")"
  make_work

  if op item get "$item" --vault "$op_vault" --fields "label=$name-access-key-id" --reveal >"$work/id" 2>/dev/null && [[ -s "$work/id" ]]; then
    echo "==> reading the key $name from 1Password '$item'" >&2
    op item get "$item" --vault "$op_vault" --fields "label=$name-secret-access-key" --reveal >"$work/secret"
    [[ -s "$work/secret" ]] || die "1Password '$item' holds $name-access-key-id but no secret"
  else
    echo "==> making the key $name and escrowing it in 1Password '$item'" >&2
    printf 'GK%s' "$(random_hex 12)" >"$work/id"
    random_hex 32 >"$work/secret"
    op item edit "$item" --vault "$op_vault" \
      "$name-access-key-id[concealed]=$(cat "$work/id")" \
      "$name-secret-access-key[concealed]=$(cat "$work/secret")" >/dev/null
  fi

  echo "==> storing the key in ${sops_file#"$root/"} as garage/keys/$name" >&2
  jq -Rs . <"$work/id" | sops set --value-stdin "$sops_file" "[\"garage\"][\"keys\"][\"$name\"][\"id\"]"
  jq -Rs . <"$work/secret" | sops set --value-stdin "$sops_file" "[\"garage\"][\"keys\"][\"$name\"][\"secret\"]"
  [[ "$(sops decrypt --extract "[\"garage\"][\"keys\"][\"$name\"][\"secret\"]" "$sops_file" | sha256sum)" == "$(sha256sum <"$work/secret")" ]] \
    || die "${sops_file#"$root/"} does not hold the key as made"

  echo "==> importing the key, creating the bucket and granting it on $tgt" >&2
  remote "$tgt" <<EOF
if ! $garage key info $name >/dev/null 2>&1; then
  jq -n --arg n "$name" --arg i "$(cat "$work/id")" --arg s "$(cat "$work/secret")" \\
    '{name: \$n, accessKeyId: \$i, secretAccessKey: \$s}' | $garage json-api ImportKey - >/dev/null
fi
$garage bucket info $name >/dev/null 2>&1 || $garage bucket create $name >/dev/null
$garage bucket allow --read --write --owner $name --key $name >/dev/null
$garage bucket allow --read $name --key push >/dev/null
$garage bucket info $name
EOF

  cat >&2 <<EOF

Done: Garage has the bucket $name, owned by the key $name, which ${sops_file#"$root/"} holds.
List "$name" in the keys and buckets of nix/services/garage.nix, commit it with the SOPS file, and deploy $host.
EOF
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
