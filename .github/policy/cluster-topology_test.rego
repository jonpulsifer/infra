package main

# Exercises the topology-contract seam: ConfigMap documents in, deny messages
# out. Mirrors the fixtures the bash predecessor built with `jq` on the real
# accepted ConfigMaps.

import rego.v1

folly := {
	"apiVersion": "v1",
	"kind": "ConfigMap",
	"metadata": {"name": "cluster-topology", "namespace": "flux-system"},
	"data": {
		"CLUSTER_NAME": "folly",
		"API_SERVER_IP": "10.3.0.10",
		"API_SERVER_HOSTNAME": "folly.lolwtf.ca",
		"API_SERVER_PORT": "6443",
		"ROUTER_IP": "10.3.0.1",
		"K8S_NODE_CIDR": "10.3.0.0/26",
		"CILIUM_POD_CIDR": "10.100.0.0/20",
		"SERVICE_CIDR": "10.10.0.0/16",
		"CLUSTER_DNS": "10.10.0.254",
		"CILIUM_NATIVE_ROUTING_CIDR": "10.0.0.0/9",
		"LB_RANGE": "10.3.0.64/26",
		"BGP_GATEWAY_ASN": "64512",
		"BGP_CILIUM_ASN": "64513",
	},
}

offsite := {
	"apiVersion": "v1",
	"kind": "ConfigMap",
	"metadata": {"name": "cluster-topology", "namespace": "flux-system"},
	"data": {
		"CLUSTER_NAME": "offsite",
		"API_SERVER_IP": "10.89.0.10",
		"API_SERVER_HOSTNAME": "offsite.lolwtf.ca",
		"API_SERVER_PORT": "6443",
		"ROUTER_IP": "10.89.0.1",
		"K8S_NODE_CIDR": "10.89.0.0/28",
		"CILIUM_POD_CIDR": "10.101.0.0/20",
		"SERVICE_CIDR": "10.11.0.0/16",
		"CLUSTER_DNS": "10.11.0.254",
		"CILIUM_NATIVE_ROUTING_CIDR": "10.0.0.0/9",
		"LB_RANGE": "10.89.0.64/26",
		"BGP_GATEWAY_ASN": "64512",
		"BGP_CILIUM_ASN": "64513",
	},
}

wrap(doc, path) := {"contents": doc, "path": path}

with_fact(doc, key, value) := result if {
	result := object.union(doc, {"data": object.union(doc.data, {key: value})})
}

without_fact(doc, key) := result if {
	# object.union deep-merges nested objects, so it cannot express deletion;
	# rebuild "data" explicitly instead of unioning away the key.
	result := {
		"apiVersion": doc.apiVersion,
		"kind": doc.kind,
		"metadata": doc.metadata,
		"data": {k: v |
			some k, v in doc.data
			k != key
		},
	}
}

test_accepted_topology_configmaps_satisfy_the_contract if {
	count(deny) == 0 with input as [wrap(folly, "folly.json"), wrap(offsite, "offsite.json")]
}

test_comma_separated_dns_list_satisfies_the_contract if {
	multiple_dns := with_fact(folly, "CLUSTER_DNS", "10.10.0.254,10.10.0.253")
	count(deny) == 0 with input as [wrap(multiple_dns, "multiple-dns.json")]
}

test_trailing_comma_dns_is_denied_with_local_diagnostic if {
	trailing_comma_dns := with_fact(folly, "CLUSTER_DNS", "10.10.0.254,")
	"multiple-dns.json: CLUSTER_DNS entries must not be empty" in deny with input as [wrap(trailing_comma_dns, "multiple-dns.json")]
}

test_missing_required_fact_is_denied_with_local_diagnostic if {
	missing_lb := without_fact(folly, "LB_RANGE")
	"missing-lb.json: LB_RANGE is required" in deny with input as [wrap(missing_lb, "missing-lb.json")]
}

test_overlapping_lb_range_is_denied_with_local_diagnostic if {
	overlapping_lb := with_fact(folly, "LB_RANGE", folly.data.K8S_NODE_CIDR)
	"overlapping-lb.json: LB_RANGE must not overlap K8S_NODE_CIDR" in deny with input as [wrap(overlapping_lb, "overlapping-lb.json")]
}

test_cross_cluster_address_space_collision_is_denied if {
	offsite_lb_overlaps_folly_pods := with_fact(offsite, "LB_RANGE", "10.100.0.0/20")
	"topology contract: pod_cidrs must not overlap lb_ranges between folly and offsite" in deny with input as [
		wrap(folly, "folly.json"),
		wrap(offsite_lb_overlaps_folly_pods, "offsite.json"),
	]
}
