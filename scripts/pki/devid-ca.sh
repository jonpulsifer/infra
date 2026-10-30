#!/usr/bin/env bash
# After Atlantis applies terraform/pki's software DevID CA: writes its certificate, its chain and the
# DevID CA bundle under terraform/pki/certs/. No service signs with the software CA: fleetd signs
# with spore's YubiKey CA (nix/services/fleetd.nix), and the bundle keeps the LDevIDs the software
# CA issued trusted until their nodes renew. Its private key stays in terraform/pki's state.

set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
pki_dir="$repo_root/terraform/pki"
certs_dir="$pki_dir/certs"

missing=()
for tool in tofu jq; do
  command -v "$tool" >/dev/null || missing+=("$tool")
done
if ((${#missing[@]})); then
  echo "missing required tool(s): ${missing[*]}" >&2
  exit 1
fi

echo "==> reading terraform/pki outputs" >&2
outputs="$(tofu -chdir="$pki_dir" output -json)"

# SPIRE's devid.caChains reads the first certificate of each file, so the CA file holds the DevID CA
# alone; the chain file holds it first, then the intermediate and the root. The bundle,
# folly-devid-ca.pem, holds every issuing DevID CA, software and hardware.
jq -er '.devid_ca_cert.value' <<<"$outputs" >"$certs_dir/folly-devid-ca-software.pem"
jq -er '.devid_ca_chain.value' <<<"$outputs" >"$certs_dir/folly-devid-ca-software-chain.pem"
echo "==> wrote certs/folly-devid-ca-software.pem and certs/folly-devid-ca-software-chain.pem" >&2
bash "$repo_root/scripts/devid-ca-yubikey.sh" bundle

echo "==> now: mise run pki:verify, then commit certs/" >&2
