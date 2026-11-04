#!/usr/bin/env bash
# The attestation story from the node's side, told through its tpm-reattest pod.
#
#   demo-tpm-node.sh <node>            # riptide, surge
#   DEMO_PAUSE=1 demo-tpm-node.sh surge  # wait for Enter between acts
#
# Read-only on the node: it reads SMBIOS, the TPM's properties, PCRs, NV certificates and the
# event log, and runs one hourly check against fleetd, the same one the DaemonSet runs each hour.
# Needs kubectl (context folly), jq and openssl on this machine.
set -euo pipefail
node=${1:?usage: demo-tpm-node.sh <node>}
ctx=${KUBE_CONTEXT:-folly}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

pod=$(kubectl --context "$ctx" -n spire get pods -l app.kubernetes.io/name=tpm-reattest \
  --field-selector "spec.nodeName=$node" -o jsonpath='{.items[0].metadata.name}')
[ -n "$pod" ] || {
  echo "no tpm-reattest pod on $node (is it a TPM 2.0 node?)" >&2
  exit 1
}
x() { kubectl --context "$ctx" -n spire exec -i "$pod" -- sh -c "$1"; }
act() { printf '\n\033[1;36m== %s\033[0m\n' "$1"; }
say() { printf '   \033[2m%s\033[0m\n' "$@"; }
pause() { if [ -n "${DEMO_PAUSE:-}" ]; then read -r -p "   [Enter] " _; fi; }
OPENSSL=${OPENSSL:-openssl}
cert() { # <nv index> <label>: pull a DER certificate out of TPM NV and describe it here
  x "tpm2_nvread $1 2>/dev/null | base64 -w0" | base64 -d >"$work/$1.der" || true
  if [ -s "$work/$1.der" ]; then
    printf '   %s (NV %s, %s bytes)\n' "$2" "$1" "$(wc -c <"$work/$1.der")"
    "$OPENSSL" x509 -inform DER -in "$work/$1.der" -noout -subject -issuer -serial -dates 2>/dev/null | sed 's/^/     /' \
      || "$OPENSSL" x509 -in "$work/$1.der" -noout -subject -issuer -serial -dates | sed 's/^/     /'
  else
    printf '   %s: NV %s is empty\n' "$2" "$1"
  fi
}

act "1. Who is this machine (SMBIOS, what NetBox keys on)"
# shellcheck disable=SC2016  # the pod expands $f
x 'for f in sys_vendor product_name product_serial product_uuid bios_version bios_date; do printf "   %-16s %s\n" "$f" "$(cat /sys/class/dmi/id/$f)"; done'
say "fleetd finds the NetBox device by product_serial; product_uuid is what Talos later fetches its config under."
pause

act "2. The TPM, and the key it was born with (the EK)"
x 'tpm2_getcap properties-fixed | grep -A2 -E "TPM2_PT_(MANUFACTURER|VENDOR_STRING_1|FIRMWARE_VERSION_1):" | grep -E "TPM2_PT|value" | sed "s/^/   /"'
echo
x 'tink-attest inspect' | sed 's/^/   /'
say "The endorsement key (EK) never leaves the chip. Its certificate, burned in by the maker, chains to a root fleetd ships" \
  "(apps/fleetd/attest/roots). fleetd also pins each EK's hash in NetBox: a certificate alone admits nothing."
pause

act "3. The registers: PCRs 0-7, SHA-256"
x 'tpm2_pcrread sha256:0,1,2,3,4,5,6,7 | sed "s/^/   /"'
say "A PCR cannot be set, only extended: new = H(old || measurement). Firmware measures each stage into them before it runs it:" \
  "0 firmware code  1 firmware config  2 option ROMs  3 their config  4 the boot application (what UEFI launched)" \
  "5 GPT/boot vars  6 power events  7 Secure Boot state: PK, KEK, db, dbx and which db certificate verified the loader."
pause

act "4. The event log: the claims behind the registers"
x 'tpm2_eventlog /sys/kernel/security/tpm0/binary_bios_measurements 2>/dev/null' >"$work/eventlog.yaml"
printf '   %s events in this boot\n' "$(grep -c '^- EventNum' "$work/eventlog.yaml")"
echo "   per PCR:"
grep -E '^  PCRIndex:' "$work/eventlog.yaml" | awk '{c[$2]++} END {for (p in c) printf "     PCR %-2s %s events\n", p, c[p]}' | sort -k2 -n
# One line per event: pcr, type, sha256 digest, variable name (PCR 7), device path hex (PCR 4).
awk '
  function flush() { if (pcr != "") printf "%s|%s|%s|%s|%s\n", pcr, type, d256, name, path }
  /^- EventNum/ {flush(); pcr=""; type=""; d256=""; name=""; path=""; alg=""}
  /^  PCRIndex:/ {pcr=$2}
  /^  EventType:/ {type=$2}
  /AlgorithmId:/ {alg=$NF}
  /^    Digest:/ && alg=="sha256" {gsub(/"/,"",$2); d256=$2}
  /UnicodeName:/ {name=$2}
  /DevicePath:/ {sub(/^[^:]*: */, ""); gsub(/\x27/,""); path=$0}
  END {flush()}
' "$work/eventlog.yaml" >"$work/events.txt"
echo
echo "   PCR 7, the Secure Boot chain of custody, in order:"
awk -F'|' '$1==7 {
  if ($2=="EV_SEPARATOR") print "     -- separator: below this line is the OS loader, above it firmware --";
  else if ($2 ~ /VARIABLE_DRIVER_CONFIG/) printf "     %-32s %s\n", "measured variable", $4;
  else if ($2 ~ /VARIABLE_AUTHORITY/) printf "     %-32s %s  (the db entry that verified the loader)\n", "authority used", $4;
  else printf "     %-32s\n", $2 }' "$work/events.txt"
echo
echo "   PCR 4, what UEFI launched (Authenticode SHA-256, as fleetd lists them under boot_applications):"
awk -F'|' '$1==4 && $2=="EV_EFI_BOOT_SERVICES_APPLICATION" {print $3 "|" $5}' "$work/events.txt" | while IFS='|' read -r d p; do
  label=$( (printf '%s' "$p" | xxd -r -p 2>/dev/null | tr -d '\000' | tr -c '[:print:]' '.' | grep -oE '\\[A-Za-z0-9_.\\-]+\.(EFI|efi)' | tail -n 1) || true)
  printf '     %s  %s\n' "$d" "${label:-(firmware or option ROM image, no file path)}"
done
say "The log is unsigned text. It is believed only because replaying it reproduces the quoted registers:"
echo
echo "   replay of the log            vs   live register"
awk '/^pcrs:/{p=1} p && /sha256:/{s=1; next} p && s && /^    [0-9]+ *:/ {gsub(/ /,""); sub(/:0x/," "); print tolower($0)}' "$work/eventlog.yaml" >"$work/replay.txt"
x 'tpm2_pcrread sha256:0,1,2,3,4,5,6,7' | awk '/^    [0-9]+ *:/ {gsub(/ /,""); sub(/:0x/," "); print tolower($0)}' >"$work/live.txt"
join "$work/replay.txt" "$work/live.txt" | awk '{m=($2==$3)?"match":"DIFFER"; printf "     PCR %-2s %s… %s… %s\n", $1, substr($2,1,16), substr($3,1,16), m}'
say "The quote fleetd receives is the TPM's own signature over these registers plus fleetd's nonce. fleetd replays the log" \
  "the same way, then judges the replayed values against the class's policy (apps/fleetd/attest/policy/talos.yaml):" \
  "PK must be the lab's, db must hold the lab's two signing certificates, and after the separator only they may have" \
  "verified the loader. Microsoft's certificates are allowed for option ROMs before the separator and nothing else."
pause

act "5. The certificates the TPM keeps in NV"
cert 0x1c00002 "EK certificate, from the maker"
cert 0x1c90000 "LDevID, the node's identity fleetd issued after its intake pass"
cert 0x1c90001 "LAK, the attestation key that signs each hourly quote"
say "Credential activation at intake proved that the AK and the EK live in the same TPM: fleetd encrypted a secret to the EK," \
  "bound to the AK's name, and only that chip could hand it back. The LDevID is what the SPIRE agent attests with."
pause

act "6. The dance, live: one hourly check against fleetd"
x 'tink-attest renew -renew-before=0 -ca-bundle=/etc/devid-ca/devid-ca.pem 2>&1' | sed 's/^/   /'
say "The LAK signed a fresh quote over PCRs 0-7 with fleetd's nonce; the event log went with it. fleetd replayed, judged," \
  "recorded the verdict and PCR 0 under this BIOS version in NetBox, and issued nothing: a check, not a renewal."
pause

act "7. fleetd's record of this node"
serial=$(x 'cat /sys/class/dmi/id/product_serial')
# shellcheck disable=SC2016  # the pod expands $ATTEST_URL
x 'wget -qO- "$ATTEST_URL/verdict/'"$serial"'"' | jq .
say "status, attested_at and ldevid_serial are what the spire-nodes.json export and the alerts read."
