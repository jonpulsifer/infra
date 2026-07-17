#!/usr/bin/env bash
# Exercises the topology-contract seam: ConfigMap files in, diagnostics out.
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
validator="$repo_root/.github/scripts/validate-cluster-topology.sh"
fixture_dir=$(mktemp -d)
trap 'rm -rf "$fixture_dir"' EXIT

pass() {
  printf 'ok - %s\n' "$1"
}

fail() {
  printf 'not ok - %s\n' "$1" >&2
  exit 1
}

if "$validator" \
  "$repo_root/clusters/folly/config/cluster-topology.json" \
  "$repo_root/clusters/offsite/config/cluster-topology.json"; then
  pass "accepted topology ConfigMaps satisfy the contract"
else
  fail "accepted topology ConfigMaps should satisfy the contract"
fi

cp "$repo_root/clusters/folly/config/cluster-topology.json" "$fixture_dir/folly.json"
jq '.data.CLUSTER_DNS = "10.10.0.254,10.10.0.253"' "$fixture_dir/folly.json" >"$fixture_dir/multiple-dns.json"
if "$validator" "$fixture_dir/multiple-dns.json"; then
  pass "each comma-separated cluster DNS address may satisfy the contract"
else
  fail "a comma-separated cluster DNS list should satisfy the contract"
fi

jq 'del(.data.LB_RANGE)' "$fixture_dir/folly.json" >"$fixture_dir/missing-lb.json"
if "$validator" "$fixture_dir/missing-lb.json" 2>"$fixture_dir/missing-lb.err"; then
  fail "a topology without LB_RANGE should fail"
elif grep -q 'LB_RANGE is required' "$fixture_dir/missing-lb.err"; then
  pass "missing required facts produce a local diagnostic"
else
  fail "missing LB_RANGE should name the violated fact"
fi

jq '.data.LB_RANGE = .data.K8S_NODE_CIDR' "$fixture_dir/folly.json" >"$fixture_dir/overlapping-lb.json"
if "$validator" "$fixture_dir/overlapping-lb.json" 2>"$fixture_dir/overlapping-lb.err"; then
  fail "an LB range overlapping nodes should fail"
elif grep -q 'LB_RANGE must not overlap K8S_NODE_CIDR' "$fixture_dir/overlapping-lb.err"; then
  pass "overlapping address spaces produce a local diagnostic"
else
  fail "overlapping address spaces should name the invariant"
fi

cp "$repo_root/clusters/offsite/config/cluster-topology.json" "$fixture_dir/offsite.json"
jq '.data.LB_RANGE = "10.100.0.0/20"' "$fixture_dir/offsite.json" >"$fixture_dir/offsite-lb-overlaps-folly-pods.json"
if "$validator" "$repo_root/clusters/folly/config/cluster-topology.json" "$fixture_dir/offsite-lb-overlaps-folly-pods.json" 2>"$fixture_dir/cross-cluster-overlap.err"; then
  fail "an offsite LB range overlapping folly pods should fail"
elif grep -q 'pod_cidrs must not overlap lb_ranges between folly and offsite' "$fixture_dir/cross-cluster-overlap.err"; then
  pass "cross-cluster address-space collisions produce a local diagnostic"
else
  fail "cross-cluster collisions should name both CIDR kinds"
fi
