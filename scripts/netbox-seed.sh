#!/usr/bin/env bash
# Imports folly into NetBox from git: the site, the device types and roles, the custom fields,
# the Kubernetes nodes from the hardware inventory, the anchors and the switch, their interfaces,
# MACs, cables and addresses, and the prefixes of both topology files, and the event rule that
# webhooks device changes to the fleet controller on spore. It finds each object by
# its natural key, creates what is missing and patches what differs, so a second run changes
# nothing. Every object it writes carries the tag `managed-by: git-seed`.
#
# NetBox access is scripts/lib/netbox.sh's environment. NETBOX_WEBHOOK_SECRET, which the operator
# exports, signs the webhook; the controller holds the same value.
set -euo pipefail
shopt -s inherit_errexit

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly root
# shellcheck source=scripts/lib/netbox.sh
source "$root/scripts/lib/netbox.sh"

readonly cluster="$root/clusters/folly/config/cluster-topology.json"
readonly anchors_json="$root/clusters/folly/config/anchor-topology.json"
readonly clients="$root/terraform/network/unifi/folly/clients.yaml"
readonly bootstrap_tf="$root/terraform/network/unifi/folly/bootstrap.tf"
readonly inventory="$root/clusters/folly/inventory/machines.yaml"
readonly anchor_names=(capsule spore forge)

NETBOX_CHANGES="$(mktemp)"
trap 'rm -f "$NETBOX_CHANGES"' EXIT

# The device types, each with the interfaces NetBox copies onto a new device of that type.
ports() { jq -cn --argjson n "$1" --argjson m "$2" --arg prefix "$3" --arg type "$4" \
  '[range($n; $m + 1) | {name: "\($prefix)\(.)", type: $type}]'; }
device_types="$(jq -cn \
  --argjson usw "$(jq -cn --argjson rj "$(ports 1 24 'Port ' 1000base-t)" --argjson sfp "$(ports 25 26 'Port ' 1000base-x-sfp)" '$rj + $sfp')" \
  --argjson udm "$(jq -cn --argjson rj "$(ports 1 9 'Port ' 1000base-t)" --argjson sfp "$(ports 10 11 'Port ' 10gbase-x-sfpp)" '$rj + $sfp')" '[
  {manufacturer: "HP", model: "HP EliteDesk 800 G2 DM 35W", slug: "hp-elitedesk-800-g2-dm-35w", interfaces: [{name: "eno1", type: "1000base-t"}]},
  {manufacturer: "HP", model: "HP EliteDesk 800 G5 Desktop Mini", slug: "hp-elitedesk-800-g5-desktop-mini", interfaces: [{name: "eno1", type: "1000base-t"}]},
  {manufacturer: "Dell", model: "OptiPlex 3050", slug: "dell-optiplex-3050", interfaces: [{name: "enp1s0", type: "1000base-t"}]},
  {manufacturer: "Raspberry Pi", model: "Raspberry Pi 5", slug: "raspberry-pi-5", interfaces: [{name: "end0", type: "1000base-t"}]},
  {manufacturer: "Ubiquiti", model: "USW 24 PoE", slug: "ubiquiti-usw-24-poe", part_number: "USL24P", interfaces: $usw},
  {manufacturer: "Ubiquiti", model: "UDM Pro", slug: "ubiquiti-udm-pro", part_number: "UDM-Pro", interfaces: $udm}
]')"
readonly device_types

seed_catalog() {
  nb_ensure extras/tags "slug=managed-by-git-seed" \
    '{"name": "managed-by: git-seed", "slug": "managed-by-git-seed", "color": "607d8b", "description": "Written by scripts/netbox-seed.sh from git"}' >/dev/null
  nb_ensure extras/tags "slug=drift" \
    '{"name": "drift", "slug": "drift", "color": "f44336", "description": "The node reports facts that differ from NetBox (scripts/inventory.sh check)"}' >/dev/null

  nb_ensure dcim/sites "slug=folly" "$(with_tags '{"name": "folly", "slug": "folly", "status": "active", "time_zone": "America/Halifax"}')" >/dev/null

  local manufacturer type slug template type_id
  while read -r manufacturer; do
    slug="$(jq -rn --arg m "$manufacturer" '$m | ascii_downcase | gsub("[^a-z0-9]+"; "-")')"
    nb_ensure dcim/manufacturers "slug=$slug" \
      "$(with_tags "$(jq -cn --arg n "$manufacturer" --arg s "$slug" '{name: $n, slug: $s}')")" >/dev/null
  done < <(jq -r '[.[].manufacturer] | unique[]' <<<"$device_types")
  while read -r type; do
    slug="$(jq -r '.slug' <<<"$type")"
    type_id="$(nb_ensure dcim/device-types "slug=$slug" "$(with_tags "$(jq -c '
      {manufacturer: {slug: (.manufacturer | ascii_downcase | gsub("[^a-z0-9]+"; "-"))},
       model, slug, part_number: (.part_number // ""), u_height: 0, is_full_depth: false}' <<<"$type")")")"
    while read -r template; do
      nb_ensure dcim/interface-templates "device_type_id=$type_id&name=$(uri "$(jq -r '.name' <<<"$template")")" \
        "$(jq -c --argjson t "$type_id" '. + {device_type: $t}' <<<"$template")" >/dev/null
    done < <(jq -c '.interfaces[]' <<<"$type")
  done < <(jq -c '.[]' <<<"$device_types")

  local role
  while read -r role; do
    nb_ensure dcim/device-roles "slug=$(jq -r '.slug' <<<"$role")" "$(with_tags "$role")" >/dev/null
  done < <(jq -c '.[]' <<<'[
    {"name": "kubernetes-node", "slug": "kubernetes-node", "color": "2196f3", "description": "A Talos node of the folly cluster"},
    {"name": "anchor", "slug": "anchor", "color": "4caf50", "description": "A Pi 5 that runs the lab network services outside the cluster"},
    {"name": "switch", "slug": "switch", "color": "9e9e9e", "description": "A UniFi switch"},
    {"name": "gateway", "slug": "gateway", "color": "ff9800", "description": "The UniFi gateway"}
  ]')
  nb_ensure dcim/platforms "slug=talos" "$(with_tags '{"name": "Talos Linux", "slug": "talos"}')" >/dev/null
  nb_ensure dcim/platforms "slug=nixos" "$(with_tags '{"name": "NixOS", "slug": "nixos"}')" >/dev/null
}

# choice_set <name> <value>...: ensure a custom field choice set whose labels are its values;
# prints its id.
choice_set() {
  local name="$1"
  shift
  nb_ensure extras/custom-field-choice-sets "name=$name" \
    "$(jq -cn --arg n "$name" '$ARGS.positional | {name: $n, extra_choices: map([., .])}' --args "$@")"
}

seed_custom_fields() {
  local field talos_class bmc_type desired_action
  talos_class="$(choice_set talos-class controlplane worker-g5 worker-g2)"
  bmc_type="$(choice_set bmc-type none amt redfish)"
  desired_action="$(choice_set desired-action none provision attest wipe)"
  while read -r field; do
    nb_ensure extras/custom-fields "name=$(jq -r '.name' <<<"$field")" \
      "$(jq -c '. + {object_types: ["dcim.device"], required: false}' <<<"$field")" >/dev/null
  done < <(jq -c '.[]' <<<'[
    {"name": "bios_version", "label": "BIOS version", "type": "text", "group_name": "Hardware", "weight": 100, "description": "SMBIOS BIOS version the node reports"},
    {"name": "sku", "label": "SKU", "type": "text", "group_name": "Hardware", "weight": 110, "description": "SMBIOS SKU number"},
    {"name": "install_disk", "label": "Install disk", "type": "text", "group_name": "Hardware", "weight": 120, "validation_regex": "^/dev/", "description": "The disk Talos installs to"},
    {"name": "amt", "label": "Intel AMT", "type": "boolean", "group_name": "Hardware", "weight": 130, "description": "The node has Intel AMT"},
    {"name": "secure_boot_expected", "label": "Secure Boot expected", "type": "boolean", "group_name": "Hardware", "weight": 140, "description": "The firmware state the node is expected to boot in"},
    {"name": "smbios_uuid", "label": "SMBIOS UUID", "type": "text", "group_name": "Hardware", "weight": 150, "description": "SMBIOS UUID of the node, written by talos-attest on an intake pass; the Talos config URL names it"},
    {"name": "tpm_version", "label": "TPM version", "type": "text", "group_name": "Identity", "weight": 200, "validation_regex": "^(1\\.2|2\\.0)$", "description": "TPM spec version; only 2.0 seals disks and attests"},
    {"name": "ek_hash", "label": "EK hash", "type": "text", "group_name": "Identity", "weight": 210, "validation_regex": "^[0-9a-f]{64}$", "description": "SHA-256 of the TPM endorsement key public area"},
    {"name": "ek_issuer", "label": "EK issuer", "type": "text", "group_name": "Identity", "weight": 220, "description": "Issuer of the TPM endorsement key certificate"},
    {"name": "ldevid_serial", "label": "LDevID serial", "type": "text", "group_name": "Identity", "weight": 230, "description": "Serial of the LDevID certificate"},
    {"name": "ldevid_not_after", "label": "LDevID not after", "type": "date", "group_name": "Identity", "weight": 240, "description": "Expiry of the LDevID certificate"},
    {"name": "lak_serial", "label": "LAK serial", "type": "text", "group_name": "Identity", "weight": 250, "description": "Serial of the LAK certificate"},
    {"name": "last_attested", "label": "Last attested", "type": "datetime", "group_name": "Identity", "weight": 260, "description": "When the node last passed attestation"},
    {"name": "ek_hash_ecc", "label": "EK hash (ECC)", "type": "text", "group_name": "Identity", "weight": 215, "validation_regex": "^[0-9a-f]{64}$", "description": "SHA-256 of the ECC TPM endorsement key public area"},
    {"name": "attest_verdict", "label": "Attest verdict", "type": "text", "group_name": "Identity", "weight": 270, "description": "attested, quarantined: <reason>, or pending-approval"},
    {"name": "attest_consumed_at", "label": "Attest consumed at", "type": "datetime", "group_name": "Identity", "weight": 280, "description": "When talos-enroll released a config on the strength of last_attested"}
  ]')
  while read -r field; do
    nb_ensure extras/custom-fields "name=$(jq -r '.name' <<<"$field")" \
      "$(jq -c '. + {object_types: ["dcim.device"], required: false}' <<<"$field")" >/dev/null
  done < <(jq -nc --argjson c "$talos_class" --argjson b "$bmc_type" --argjson a "$desired_action" '[
    {name: "talos_class", label: "Talos class", type: "select", choice_set: $c, group_name: "Fleet", weight: 300, description: "The class git declares for the node: its role and patches"},
    {name: "bmc_type", label: "BMC type", type: "select", choice_set: $b, group_name: "Fleet", weight: 310, description: "The out-of-band management the node has"},
    {name: "desired_action", label: "Desired action", type: "select", choice_set: $a, default: "none", group_name: "Fleet", weight: 320, description: "What the fleet controller does next: provision (attest, wipe, install), attest, or wipe"},
    {name: "last_workflow", label: "Last workflow", type: "text", group_name: "Fleet", weight: 330, description: "The newest Workflow the fleet controller made"}
  ] | .[]')
}

# seed_webhook: the webhook to the fleet controller on spore's anchor address, and the event rule
# that sends every device update to it. NetBox conditions see only the new state, not the change,
# so the rule cannot filter on a status change; the controller ignores updates that need nothing.
seed_webhook() {
  local webhook_id spore
  spore="$(jq -er '.data.SPORE_IP' "$anchors_json")"
  webhook_id="$(nb_ensure extras/webhooks "name=fleet-controller" "$(with_tags "$(jq -cn --arg u "http://$spore:8446/webhook" '{
    name: "fleet-controller", payload_url: $u, http_method: "POST", http_content_type: "application/json", ssl_verification: false,
    description: "Wakes the fleet controller on spore"}')")")"
  nb PATCH "extras/webhooks/$webhook_id/" "$(jq -cn '{secret: $ENV.NETBOX_WEBHOOK_SECRET}')" >/dev/null
  nb_ensure extras/event-rules "name=fleet-controller-device-update" "$(with_tags "$(jq -cn --argjson w "$webhook_id" '{
    name: "fleet-controller-device-update", object_types: ["dcim.device"], event_types: ["object_updated"], enabled: true,
    action_type: "webhook", action_object_type: "extras.webhook", action_object_id: $w,
    description: "A device changed; the controller reconciles on desired_action and status"}')")" >/dev/null
}

seed_prefixes() {
  local site_id="$1" prefix
  while read -r prefix; do
    nb_ensure ipam/prefixes "prefix=$(uri "$(jq -r '.prefix' <<<"$prefix")")" \
      "$(with_tags "$(jq -c --argjson s "$site_id" '. + {status: "active", scope_type: "dcim.site", scope_id: $s}' <<<"$prefix")")" >/dev/null
  done < <(jq -cs '
    map(.data | to_entries[]) | map(select(.value | test("^[0-9.]+/[0-9]+$")))
    | group_by(.value)[] | {prefix: .[0].value, description: (map(.key) | join(", "))}' "$cluster" "$anchors_json")
}

[[ -n "${NETBOX_WEBHOOK_SECRET:-}" ]] || {
  echo "export NETBOX_WEBHOOK_SECRET, the secret the fleet controller verifies, before seeding" >&2
  exit 1
}
export NETBOX_WEBHOOK_SECRET
nb_init
seed_catalog
seed_custom_fields
seed_webhook
site_id="$(nb GET "dcim/sites/?slug=folly" | jq -e '.results[0].id')"
seed_prefixes "$site_id"

switch_name="$(yq -r '.switches | keys | .[0]' "$clients")"
switch_mac="$(yq -r ".switches[\"$switch_name\"].mac" "$clients")"
switch_id="$(device "$(jq -cn --arg n "$switch_name" '{name: $n, role: {slug: "switch"}, device_type: {slug: "ubiquiti-usw-24-poe"}, status: "active"}')")"
interface "$switch_id" mgmt "$switch_mac" virtual >/dev/null

node_len="$(jq -er '.data.K8S_NODE_CIDR | split("/")[1]' "$cluster")"
addresses="$(jq -er '.data.NODE_ADDRESSES | fromjson' "$cluster")"
readonly node_fleet='{
  "optiplex": {"talos_class": "controlplane", "bmc_type": "none"},
  "shale": {"talos_class": "worker-g2", "bmc_type": "amt"},
  "riptide": {"talos_class": "worker-g5", "bmc_type": "amt"}
}'
for node in $(yq -r '.machines | keys | .[]' "$inventory"); do
  m="$(yq -o json -I0 ".machines.$node" "$inventory")"
  type="$(jq -c --argjson m "$m" '.[] | select(.model == $m.model)' <<<"$device_types")"
  [[ -n "$type" ]] || {
    echo "$node: no device type for model $(jq -r '.model' <<<"$m")" >&2
    exit 1
  }
  fleet="$(jq -ec --arg n "$node" '.[$n]' <<<"$node_fleet")" || {
    echo "$node: no talos_class and bmc_type in node_fleet" >&2
    exit 1
  }
  current="$(nb GET "dcim/devices/?site=folly&name=$(uri "$node")" | jq -c '.results[0] // null')"
  id="$(device "$(jq -cn --arg n "$node" --argjson m "$m" --argjson t "$type" --argjson f "$fleet" --argjson cur "$current" '{
    name: $n, role: {slug: "kubernetes-node"}, device_type: {slug: $t.slug}, platform: {slug: "talos"},
    serial: $m.serial,
    custom_fields: ({bios_version: $m.bios, sku: $m.sku, install_disk: $m.disk, amt: $m.amt,
      secure_boot_expected: $m.secure_boot, tpm_version: $m.tpm}
      + ($f | with_entries(select($cur == null or ($cur.custom_fields[.key] | . == null or . == "" or . == {})))))
  } + (if $cur == null then {status: "active"} else {} end)')")"
  nic="$(interface "$id" "$(jq -r '.interfaces[0].name' <<<"$type")" "$(jq -r '.mac' <<<"$m")")"
  nb_cable "$nic" "$(switch_port "$(jq -r '.switch_port' <<<"$m")")" "$tags"
  ip="$(jq -er --arg n "$node" '.[$n]' <<<"$addresses")"
  address "$id" "$nic" "$ip/$node_len"
done

anchor_len="$(jq -er '.data.ANCHOR_CIDR | split("/")[1]' "$anchors_json")"
anchor_ports="$(awk '/anchor_ports = \{/ {on = 1; next} on && /\}/ {exit} on {print $1, $3}' "$bootstrap_tf")"
for anchor in "${anchor_names[@]}"; do
  mac="$(yq -er ".rpis.$anchor.mac" "$clients")"
  ip="$(jq -er --arg k "${anchor^^}_IP" '.data[$k]' "$anchors_json")"
  port="$(awk -v a="$anchor" '$1 == a {print $2}' <<<"$anchor_ports")"
  [[ -n "$port" ]] || {
    echo "$anchor: no switch port in ${bootstrap_tf#"$root"/}" >&2
    exit 1
  }
  id="$(device "$(jq -cn --arg n "$anchor" '{name: $n, role: {slug: "anchor"}, device_type: {slug: "raspberry-pi-5"}, platform: {slug: "nixos"}, status: "active"}')")"
  nic="$(interface "$id" end0 "$mac")"
  nb_cable "$nic" "$(switch_port "$port")" "$tags"
  address "$id" "$nic" "$ip/$anchor_len"
done

echo "$(wc -l <"$NETBOX_CHANGES") changes"
