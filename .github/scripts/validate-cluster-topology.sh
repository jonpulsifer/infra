#!/usr/bin/env bash
# Validates the cluster-topology ConfigMap contract. The JSON files remain the
# source of truth; this module only turns their facts into actionable failures.
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
if (($# == 0)); then
  set -- \
    "$repo_root/clusters/folly/config/cluster-topology.json" \
    "$repo_root/clusters/offsite/config/cluster-topology.json"
fi

required_keys=(
  CLUSTER_NAME
  API_SERVER_IP
  API_SERVER_HOSTNAME
  API_SERVER_PORT
  ROUTER_IP
  K8S_NODE_CIDR
  CILIUM_POD_CIDR
  SERVICE_CIDR
  CLUSTER_DNS
  CILIUM_NATIVE_ROUTING_CIDR
  LB_RANGE
  BGP_GATEWAY_ASN
  BGP_CILIUM_ASN
)

errors=0

diagnose() {
  printf '%s: %s\n' "$1" "$2" >&2
  errors=1
}

ipv4_to_int() {
  local value=$1 a b c d
  [[ $value =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
  a=${BASH_REMATCH[1]}
  b=${BASH_REMATCH[2]}
  c=${BASH_REMATCH[3]}
  d=${BASH_REMATCH[4]}
  ((10#$a <= 255 && 10#$b <= 255 && 10#$c <= 255 && 10#$d <= 255)) || return 1
  printf '%u\n' "$(( (10#$a << 24) + (10#$b << 16) + (10#$c << 8) + 10#$d ))"
}

cidr_range() {
  local cidr=$1 address prefix ip mask start end
  [[ $cidr =~ ^([^/]+)/([0-9]{1,2})$ ]] || return 1
  address=${BASH_REMATCH[1]}
  prefix=${BASH_REMATCH[2]}
  ((10#$prefix <= 32)) || return 1
  ip=$(ipv4_to_int "$address") || return 1
  mask=$(( (0xFFFFFFFF << (32 - 10#$prefix)) & 0xFFFFFFFF ))
  start=$((ip & mask))
  ((ip == start)) || return 1
  end=$((start | (0xFFFFFFFF ^ mask)))
  printf '%u %u\n' "$start" "$end"
}

cidr_contains() {
  local outer_start outer_end inner_start inner_end
  read -r outer_start outer_end < <(cidr_range "$1") || return 1
  read -r inner_start inner_end < <(cidr_range "$2") || return 1
  ((outer_start <= inner_start && outer_end >= inner_end))
}

cidrs_overlap() {
  local first_start first_end second_start second_end
  read -r first_start first_end < <(cidr_range "$1") || return 1
  read -r second_start second_end < <(cidr_range "$2") || return 1
  ((first_start <= second_end && second_start <= first_end))
}

ip_in_cidr() {
  local ip=$1 cidr=$2 value start end
  value=$(ipv4_to_int "$ip") || return 1
  read -r start end < <(cidr_range "$cidr") || return 1
  ((start <= value && value <= end))
}

declare -a cluster_names node_cidrs pod_cidrs service_cidrs lb_ranges

for topology_file in "$@"; do
  if [[ ! -f $topology_file ]]; then
    diagnose "$topology_file" "file does not exist"
    continue
  fi
  if ! jq -e . "$topology_file" >/dev/null 2>&1; then
    diagnose "$topology_file" "must contain valid JSON"
    continue
  fi
  if ! jq -e '.apiVersion == "v1" and .kind == "ConfigMap" and .metadata.name == "cluster-topology" and .metadata.namespace == "flux-system"' "$topology_file" >/dev/null; then
    diagnose "$topology_file" "must be the flux-system/cluster-topology ConfigMap"
  fi
  if ! jq -e '.data | type == "object" and all(.[]; type == "string")' "$topology_file" >/dev/null; then
    diagnose "$topology_file" "data must be a flat string-to-string map"
    continue
  fi

  declare -A fact=()
  for key in "${required_keys[@]}"; do
    if ! jq -e --arg key "$key" '.data[$key] | type == "string" and length > 0' "$topology_file" >/dev/null; then
      diagnose "$topology_file" "$key is required"
    else
      fact[$key]=$(jq -r --arg key "$key" '.data[$key]' "$topology_file")
    fi
  done
  ((${#fact[@]} == ${#required_keys[@]})) || continue

  for key in API_SERVER_IP ROUTER_IP; do
    if ! ipv4_to_int "${fact[$key]}" >/dev/null; then
      diagnose "$topology_file" "$key must be an IPv4 address"
    fi
  done
  IFS=, read -r -a cluster_dns_addresses <<<"${fact[CLUSTER_DNS]}"
  for cluster_dns in "${cluster_dns_addresses[@]}"; do
    if ! ipv4_to_int "$cluster_dns" >/dev/null; then
      diagnose "$topology_file" "each CLUSTER_DNS entry must be an IPv4 address"
    elif ! ip_in_cidr "$cluster_dns" "${fact[SERVICE_CIDR]}"; then
      diagnose "$topology_file" "each CLUSTER_DNS entry must be in SERVICE_CIDR"
    fi
  done
  for key in K8S_NODE_CIDR CILIUM_POD_CIDR SERVICE_CIDR CILIUM_NATIVE_ROUTING_CIDR LB_RANGE; do
    if ! cidr_range "${fact[$key]}" >/dev/null; then
      diagnose "$topology_file" "$key must be a canonical IPv4 CIDR"
    fi
  done
  if [[ ! ${fact[API_SERVER_PORT]} =~ ^[0-9]+$ ]] || ((10#${fact[API_SERVER_PORT]} < 1 || 10#${fact[API_SERVER_PORT]} > 65535)); then
    diagnose "$topology_file" "API_SERVER_PORT must be between 1 and 65535"
  fi
  for key in BGP_GATEWAY_ASN BGP_CILIUM_ASN; do
    if [[ ! ${fact[$key]} =~ ^[0-9]+$ ]] || ((10#${fact[$key]} < 1 || 10#${fact[$key]} > 4294967295)); then
      diagnose "$topology_file" "$key must be a BGP ASN"
    fi
  done
  if [[ ${fact[BGP_GATEWAY_ASN]} == "${fact[BGP_CILIUM_ASN]}" ]]; then
    diagnose "$topology_file" "BGP_GATEWAY_ASN and BGP_CILIUM_ASN must differ"
  fi
  if ! ip_in_cidr "${fact[API_SERVER_IP]}" "${fact[K8S_NODE_CIDR]}"; then
    diagnose "$topology_file" "API_SERVER_IP must be in K8S_NODE_CIDR"
  fi
  if ! ip_in_cidr "${fact[ROUTER_IP]}" "${fact[K8S_NODE_CIDR]}"; then
    diagnose "$topology_file" "ROUTER_IP must be in K8S_NODE_CIDR"
  fi
  if cidrs_overlap "${fact[LB_RANGE]}" "${fact[K8S_NODE_CIDR]}"; then
    diagnose "$topology_file" "LB_RANGE must not overlap K8S_NODE_CIDR"
  fi
  for key in K8S_NODE_CIDR CILIUM_POD_CIDR LB_RANGE; do
    if ! cidr_contains "${fact[CILIUM_NATIVE_ROUTING_CIDR]}" "${fact[$key]}"; then
      diagnose "$topology_file" "CILIUM_NATIVE_ROUTING_CIDR must contain $key"
    fi
  done

  cluster_names+=("${fact[CLUSTER_NAME]}")
  node_cidrs+=("${fact[K8S_NODE_CIDR]}")
  pod_cidrs+=("${fact[CILIUM_POD_CIDR]}")
  service_cidrs+=("${fact[SERVICE_CIDR]}")
  lb_ranges+=("${fact[LB_RANGE]}")
done

for ((i = 0; i < ${#cluster_names[@]}; i++)); do
  for ((j = i + 1; j < ${#cluster_names[@]}; j++)); do
    if [[ ${cluster_names[i]} == "${cluster_names[j]}" ]]; then
      diagnose "topology contract" "CLUSTER_NAME values must be unique"
    fi
    for first_kind in node_cidrs pod_cidrs service_cidrs lb_ranges; do
      declare -n first_ranges="$first_kind"
      for second_kind in node_cidrs pod_cidrs service_cidrs lb_ranges; do
        declare -n second_ranges="$second_kind"
        if cidrs_overlap "${first_ranges[i]}" "${second_ranges[j]}"; then
          diagnose "topology contract" "${first_kind} must not overlap ${second_kind} between ${cluster_names[i]} and ${cluster_names[j]}"
        fi
      done
    done
  done
done

if ((errors)); then
  exit 1
fi

printf 'topology contract: validated %d ConfigMap(s)\n' "$#"
