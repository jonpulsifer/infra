#!/usr/bin/env bash
# Mints the CA, serving certificate, admin client certificate and service-account key of the
# kube-apiserver that Tinkerbell embeds on spore. With --out <dir> it only writes the files there.
# Otherwise it stores them in spore's SOPS file and the 1Password item, and shreds its copy.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly root
readonly sops_file="$root/nix/secrets/spore.sops.yaml"
readonly item="spore tinkerbell api"
readonly vault="homelab"
readonly days=3650

out=""
case "${1:-}" in
  --out)
    out="${2:?--out needs a directory}"
    ;;
  "") ;;
  *)
    echo "usage: $0 [--out <dir>]" >&2
    exit 2
    ;;
esac

spore_ip="$(jq -er .data.SPORE_IP "$root/clusters/folly/config/lab-topology.json")"
zone="$(jq -er .locals.fleet.dns_zone "$root/terraform/network/tailscale/fleet.tf.json")"
tailnet="$(jq -er .locals.fleet.tailnet "$root/terraform/network/tailscale/fleet.tf.json")"

umask 077
work="$(mktemp -d)"
trap 'find "$work" -type f -exec shred -u {} +; rm -rf "$work"' EXIT

key() {
  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$work/$1.key"
}

sign() {
  local name="$1" subject="$2" ext="$3"
  key "$name"
  openssl req -new -key "$work/$name.key" -subj "$subject" -out "$work/$name.csr"
  printf '%s\n' "$ext" >"$work/$name.ext"
  openssl x509 -req -in "$work/$name.csr" -CA "$work/ca.crt" -CAkey "$work/ca.key" \
    -days "$days" -set_serial "0x$(openssl rand -hex 16)" -extfile "$work/$name.ext" \
    -out "$work/$name.crt" 2>/dev/null
}

key ca
openssl req -x509 -new -key "$work/ca.key" -subj "/CN=spore tinkerbell CA" -days "$days" \
  -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -out "$work/ca.crt"

sign server "/CN=kube-apiserver" "basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=serverAuth
subjectAltName=DNS:localhost,DNS:spore,DNS:spore.$zone,DNS:spore.$tailnet,DNS:kubernetes,DNS:kubernetes.default,DNS:kubernetes.default.svc,IP:127.0.0.1,IP:$spore_ip"

# system:masters bypasses RBAC; only Tinkerbell's own services on spore hold this key.
sign admin "/O=system:masters/CN=tinkerbell-admin" "basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=clientAuth"

# With a P-256 service-account key, the embedded apiserver never finishes its TLS handshakes.
openssl genpkey -quiet -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$work/service-account.key"

files=(ca.crt server.crt server.key admin.crt admin.key service-account.key)

if [[ -n "$out" ]]; then
  install -d -m 0700 "$out"
  for f in "${files[@]}" ca.key; do
    install -m 0600 "$work/$f" "$out/$f"
  done
  exit 0
fi

: "${SOPS_AGE_KEY_FILE:?set SOPS_AGE_KEY_FILE to the operator key}"

if op item get "$item" --vault "$vault" >/dev/null 2>&1; then
  echo "1Password item '$item' exists; archive it before a rotation" >&2
  exit 1
fi

# 1Password holds the only copy of the CA key, so the item is written and read back first.
for f in ca.key "${files[@]}"; do
  type=STRING
  [[ "$f" == *.key ]] && type=CONCEALED
  jq -n --arg label "$f" --arg type "$type" --rawfile value "$work/$f" \
    '{label: $label, type: $type, value: $value}'
done | jq -s --arg title "$item" '{
  title: $title,
  category: "SECURE_NOTE",
  fields: ([{id: "notesPlain", type: "STRING", purpose: "NOTES",
    value: "The embedded kube-apiserver of Tinkerbell on spore, minted by scripts/tinkerbell-certs.sh."}] + .)
}' >"$work/item.json"
op item create --vault "$vault" --template "$work/item.json" >/dev/null

op item get "$item" --vault "$vault" --reveal --format json >"$work/stored.json"
for f in ca.key "${files[@]}"; do
  stored="$(jq -j --arg label "$f" '.fields[] | select(.label == $label) | .value' "$work/stored.json" | sha256sum)"
  if [[ "$stored" != "$(sha256sum <"$work/$f")" ]]; then
    echo "1Password item '$item' does not hold $f as minted; SOPS is unchanged" >&2
    exit 1
  fi
done

# spore never holds the CA key.
for f in "${files[@]}"; do
  jq -Rs . <"$work/$f" | sops set --value-stdin "$sops_file" "[\"tinkerbell\"][\"${f//./-}\"]"
done
echo "stored in $sops_file and the 1Password item '$item'"
