#!/usr/bin/env bash
# After Atlantis applies terraform/pki's DevID CA: commits its certificate and chain under
# terraform/pki/certs/ and seals its private key into each anchor's sops file, where sops-nix hands
# it to talos-attest (nix/services/talos-attest.nix). The key never reaches stdout or argv.
# Run with the owner's age key: SOPS_AGE_KEY_FILE=~/.config/age/keys.txt.

set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
pki_dir="$repo_root/terraform/pki"
certs_dir="$pki_dir/certs"
anchors=(capsule forge spore)

missing=()
for tool in tofu jq sops; do
  command -v "$tool" >/dev/null || missing+=("$tool")
done
if ((${#missing[@]})); then
  echo "missing required tool(s): ${missing[*]}" >&2
  exit 1
fi

echo "==> reading terraform/pki outputs" >&2
outputs="$(tofu -chdir="$pki_dir" output -json)"

# SPIRE's devid_ca_path trusts every certificate in its file, so the CA file holds the DevID CA
# alone; the chain file holds it first, then the intermediate and the root.
jq -er '.devid_ca_cert.value' <<<"$outputs" >"$certs_dir/folly-devid-ca.pem"
jq -er '.devid_ca_chain.value' <<<"$outputs" >"$certs_dir/folly-devid-ca-chain.pem"
echo "==> wrote certs/folly-devid-ca.pem and certs/folly-devid-ca-chain.pem" >&2

for anchor in "${anchors[@]}"; do
  file="$repo_root/nix/secrets/$anchor.sops.yaml"
  jq -e '.devid_ca_private_key.value | tostring' <<<"$outputs" \
    | sops set --value-stdin "$file" '["talos-attest"]["devid-ca-key"]'
  echo "==> sealed the DevID CA key into nix/secrets/$anchor.sops.yaml" >&2
done

echo "==> now: go -C apps/fml-pki run . verify, then commit certs/ and the three sops files" >&2
