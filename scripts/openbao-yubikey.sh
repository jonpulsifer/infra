#!/usr/bin/env bash
# Puts OpenBao's unseal key into the YubiKey on an anchor, from the operator machine over ssh. init
# stores new PIV secrets, imports the RSA-2048 unseal key from 1Password into slot 9d (generating and
# escrowing it on the first anchor), and proves that ykcs11 decrypts with it, which is what the
# pkcs11 seal does at every start. docs/runbooks/initialize-openbao.md.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly root
# shellcheck source=scripts/yubikey.sh
source "$root/scripts/yubikey.sh"
readonly slot="9d"
readonly key_item="openbao-unseal-key"
readonly key_bits=2048

usage() {
  echo "usage: $0 init <host>" >&2
  exit 2
}

# unseal_key writes the escrowed unseal key to $work/unseal.pem, or generates one and escrows it.
# Every Raft voter unseals with the same key, so it cannot be generated on a card.
unseal_key() {
  if op item get "$key_item" --vault "$op_vault" >/dev/null 2>&1; then
    echo "==> reading the unseal key from 1Password '$key_item'" >&2
    op item get "$key_item" --vault "$op_vault" --fields label=private-key --reveal --format json \
      | jq -j .value >"$work/unseal.pem"
    openssl pkey -in "$work/unseal.pem" -noout 2>/dev/null || die "1Password '$key_item' holds no readable private key"
    return
  fi
  echo "==> generating a new RSA-$key_bits unseal key and escrowing it in 1Password '$key_item'" >&2
  openssl genpkey -algorithm RSA -pkeyopt "rsa_keygen_bits:$key_bits" -out "$work/unseal.pem" 2>/dev/null
  openssl pkey -in "$work/unseal.pem" -pubout -out "$work/unseal.pub" 2>/dev/null
  jq -n \
    --arg title "$key_item" \
    --arg notes "The RSA key that wraps OpenBao's barrier key through the pkcs11 seal. Imported into PIV slot $slot of each anchor's YubiKey by scripts/openbao-yubikey.sh. A Raft voter cannot unseal without it." \
    --rawfile key "$work/unseal.pem" --rawfile pub "$work/unseal.pub" '{
      title: $title,
      category: "SECURE_NOTE",
      fields: [
        {id: "notesPlain", type: "STRING", purpose: "NOTES", value: $notes},
        {label: "private-key", type: "CONCEALED", value: $key},
        {label: "public-key", type: "STRING", value: $pub}
      ]
    }' >"$work/item.json"
  op item create --vault "$op_vault" --template "$work/item.json" >/dev/null
  local stored
  stored="$(op item get "$key_item" --vault "$op_vault" --fields label=private-key --reveal --format json | jq -j .value | sha256sum)"
  [[ "$stored" == "$(sha256sum <"$work/unseal.pem")" ]] || die "1Password '$key_item' does not hold the key as generated"
}

init_key() {
  local host="${1:-}"
  [[ -n "$host" ]] || usage
  check_host "$host"
  need jq nix op openssl sops ssh od
  : "${SOPS_AGE_KEY_FILE:?set SOPS_AGE_KEY_FILE to the operator key}"

  local sops_file="$root/nix/secrets/$host.sops.yaml"
  local item="yubikey-$host"
  local tgt serial fw id
  tgt="$(target "$host")"
  card_info "$host" "$tgt"
  id="$(slot_id "$slot")"

  make_work
  unseal_key
  new_piv_secrets "$host" "$item" "$slot" \
    "The PIV secrets of the YubiKey on $host, which holds OpenBao's unseal key in slot $slot, set by scripts/openbao-yubikey.sh."

  echo "==> setting the PIV secrets, importing the unseal key into slot $slot and decrypting through PKCS#11" >&2
  local subject="CN=OpenBao unseal $host,O=$org"
  if ! remote "$tgt" <<EOF
ykman() { command ykman --device $serial "\$@"; }
work="\$(mktemp -d /run/yubikey.XXXXXX)"
trap 'find "\$work" -type f -exec shred -u {} +; rm -rf "\$work"' EXIT
cat >"\$work/unseal.pem" <<'PEM'
$(cat "$work/unseal.pem")
PEM
$(piv_secrets_script)
ykman piv keys import -m $(cat "$work/piv-mgmt-key") --pin-policy ONCE --touch-policy NEVER $slot "\$work/unseal.pem" >&2
# ykcs11 lists a slot's key only when a certificate sits in the slot.
ykman piv certificates generate -m $(cat "$work/piv-mgmt-key") -P $(cat "$work/piv-pin") -s $(printf '%q' "$subject") $slot <(openssl pkey -in "\$work/unseal.pem" -pubout) >&2
ykman piv info >&2
openssl pkey -in "\$work/unseal.pem" -pubout -out "\$work/pub.pem"
printf 'openbao unseal self-test %s\n' "\$(date -u +%FT%TZ)" >"\$work/data"
openssl pkeyutl -encrypt -pubin -inkey "\$work/pub.pem" -pkeyopt rsa_padding_mode:oaep -pkeyopt rsa_oaep_md:sha256 -pkeyopt rsa_mgf1_md:sha256 -in "\$work/data" -out "\$work/ct"
label="YubiKey PIV #$serial"
pkcs11-tool --module $ykcs11 --token-label "\$label" --list-objects >&2
pkcs11-tool --module $ykcs11 --token-label "\$label" --login --pin $(cat "$work/piv-pin") --decrypt -m RSA-PKCS-OAEP --hash-algorithm SHA256 --mgf MGF1-SHA256 --id $id -i "\$work/ct" -o "\$work/pt" >&2
cmp -s "\$work/data" "\$work/pt" || { echo "ykcs11 did not decrypt what the public key encrypted" >&2; exit 1; }
echo "token label: \$label" >&2
EOF
  then
    die "the card refused a step; 1Password '$item' and ${sops_file#"$root/"} hold its new secrets (runbook: If something goes wrong)"
  fi

  cat >&2 <<EOF

Done: slot $slot of YubiKey $serial on $host holds the unseal key, and ykcs11 decrypts with it.
Next:
  1. In nix/hosts/$host.nix, set homelab.yubikey.serial = $serial; and homelab.openbao.enable = true;
  2. Commit ${sops_file#"$root/"} and nix/hosts/$host.nix, open a pull request, merge it and deploy $host.
  3. Follow "Initialize the server" in docs/runbooks/initialize-openbao.md.
EOF
}

main() {
  case "${1:-}" in
    init) init_key "${2:-}" ;;
    *) usage ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
