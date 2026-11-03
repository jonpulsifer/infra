#!/usr/bin/env bash
# The attestation story from the verifier's side: what fleetd on spore holds, trusts and decided.
#
#   demo-tpm-spore.sh <node> [serial]      # runs over ssh to spore; serial defaults from NetBox's inventory
#   demo-tpm-spore.sh surge --follow       # tail fleetd's journal for the node while the node script runs act 6
#
# Read-only. Needs ssh to spore (sudo there) and the repo checkout for the node's serial.
set -euo pipefail
node=${1:?usage: demo-tpm-spore.sh <node> [serial|--follow]}
host=${SPORE_HOST:-spore.pirate-musical.ts.net}
repo=${REPO:-$(git rev-parse --show-toplevel 2>/dev/null || echo /home/jawn/src/github.com/jonpulsifer/infra)}
arg=${2:-}
if [ "$arg" = "--follow" ]; then
  exec ssh -t "$host" "sudo journalctl -fu fleetd -o cat | grep --line-buffered -E '\"machine\":\"$node\"|\"node\":\"$node\"'"
fi
serial=${arg:-$(awk -v n="$node" '$1==n":"{f=1} f && /serial:/{print $2; exit}' "$repo/clusters/folly/inventory/nodes.yaml")}
[ -n "$serial" ] || { echo "no serial for $node in clusters/folly/inventory/nodes.yaml; pass it" >&2; exit 1; }

ssh "$host" NODE="$node" SERIAL="$serial" 'bash -s' <<'REMOTE'
set -u
envv() { systemctl show fleetd -p Environment | tr " " "\n" | sed -n "s/^$1=//p"; }
act() { printf '\n\033[1;36m== %s\033[0m\n' "$1"; }
say() { printf '   \033[2m%s\033[0m\n' "$@"; }

act "1. What fleetd trusts before it has met a machine"
echo "   EK roots, the TPM makers:"
ls "$(envv ATTEST_EK_ROOTS)" | sed 's/^/     /'
echo "   The DevID CA that signs every LDevID and LAK, on spore's YubiKey, up to the FML root:"
openssl crl2pkcs7 -nocrl -certfile "$(envv ATTEST_CA_CHAIN)" | openssl pkcs7 -print_certs -noout | grep subject= | sed 's/^subject=/     /'
say "The private key never leaves the YubiKey; fleetd signs through PKCS#11."

act "2. The policy a Talos class must satisfy (apps/fleetd/attest/policy/talos.yaml)"
sed -n '/^pcrs:/,$p' "$(envv ATTEST_POLICY)/talos.yaml" | grep -vE '^\s*#' | sed 's/^/   /'
say "Hashes are SHA-256 of certificate DER; names at the bottom translate them. required_authorities is the HookOS key:" \
    "only a HookOS boot earns an LDevID at intake. A running node's hourly check needs only the allowed authorities."

act "3. What a machine's pass proved: the newest verdicts for $NODE ($SERIAL)"
sudo grep "\"serial\":\"$SERIAL\"" "$(envv ATTEST_STATE_DIR)/verdicts.jsonl" | tail -n 2 | jq .
printf '   %s verdicts on file for this serial, %s of them not a pass\n' \
  "$(sudo grep -c "\"serial\":\"$SERIAL\"" "$(envv ATTEST_STATE_DIR)/verdicts.jsonl")" \
  "$(sudo grep "\"serial\":\"$SERIAL\"" "$(envv ATTEST_STATE_DIR)/verdicts.jsonl" | grep -vc '"verdict":"pass"')"
say "ek_hashes are what NetBox's approved_ek_hash fields must equal. boot_applications are the Authenticode hashes PCR 4 saw;" \
    "pinning them in the policy (boot_applications:) would tie the pass to one signed iPXE and one HookOS build."

act "4. The identity fleetd serves for the node"
curl -s "http://127.0.0.1:8444/verdict/$SERIAL" | jq .
curl -s "http://127.0.0.1:8444/devid/$SERIAL" | jq 'with_entries(.value |= (if type=="string" and length>80 then .[0:60]+"…" else . end))'
say "The SPIRE agent's devid-init fetches the LDevID package from this listener; the agent attests to spire-server with" \
    "the tpm_devid node attestor, and the fleet-entries unit on spore keys its registration on these EK hashes."

act "5. The last hour in fleetd's journal for $NODE"
sudo journalctl -u fleetd --since "-60 min" --no-pager -o cat | grep -E "\"machine\":\"$NODE\"|\"node\":\"$NODE\"" | tail -n 8 | cut -c1-220 | sed 's/^/   /'
say "renewal started → attestation passed → attest.check pass is one hourly round trip. Run this script with --follow in a" \
    "second window while the node script performs act 6, to watch one arrive."

act "6. The pins that gate the next intake, in NetBox"
tok=$(sudo cat /run/credentials/fleetd.service/netbox-token)
curl -s -H "Authorization: Token $tok" "$(envv FLEET_NETBOX_URL)/api/dcim/devices/?name=$NODE" \
  | jq '.results[0] | {status: .status.value} + (.custom_fields | {class, tpm_version, secure_boot_expected, approved_ek_hash, ek_hash, approved_ek_hash_ecc, ek_hash_ecc, ek_issuer, attest_verdict, last_attested, ldevid_serial, ldevid_not_after, lak_serial, bios_version, pcr0_by_bios})'
say "approved_* come from git (clusters/folly/inventory/nodes.yaml) through Terraform; ek_hash* are what the pass proved." \
    "Terraform's user must be the last to touch the approved fields, or fleetd ignores them."
REMOTE
