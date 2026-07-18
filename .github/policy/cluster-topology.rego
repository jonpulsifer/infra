package main

# Validates the cluster-topology ConfigMap contract. The JSON files remain the
# source of truth; this policy only turns their facts into actionable denials.
#
# Expects `input` to be the conftest --combine shape: an array of
# {"contents": <ConfigMap>, "path": <file path>}.

import rego.v1

required_keys := {
	"CLUSTER_NAME",
	"API_SERVER_IP",
	"API_SERVER_HOSTNAME",
	"API_SERVER_PORT",
	"ROUTER_IP",
	"K8S_NODE_CIDR",
	"CILIUM_POD_CIDR",
	"SERVICE_CIDR",
	"CLUSTER_DNS",
	"CILIUM_NATIVE_ROUTING_CIDR",
	"LB_RANGE",
	"BGP_GATEWAY_ASN",
	"BGP_CILIUM_ASN",
}

cidr_keys := {"K8S_NODE_CIDR", "CILIUM_POD_CIDR", "SERVICE_CIDR", "CILIUM_NATIVE_ROUTING_CIDR", "LB_RANGE"}

# range_kind maps the diagnostic name (matching the bash predecessor's
# variable names) to the fact it reads.
range_kind := {
	"node_cidrs": "K8S_NODE_CIDR",
	"pod_cidrs": "CILIUM_POD_CIDR",
	"service_cidrs": "SERVICE_CIDR",
	"lb_ranges": "LB_RANGE",
}

octet_pattern := `^[0-9]{1,3}$`

digits_pattern := `^[0-9]+$`

ipv4_to_int(ip) := n if {
	parts := split(ip, ".")
	count(parts) == 4
	every p in parts {
		regex.match(octet_pattern, p)
	}
	octets := [to_number(p) | some p in parts]
	every o in octets {
		o <= 255
	}
	n := bits.or(
		bits.or(bits.lsh(octets[0], 24), bits.lsh(octets[1], 16)),
		bits.or(bits.lsh(octets[2], 8), octets[3]),
	)
}

cidr_prefix(cidr) := prefix if {
	parts := split(cidr, "/")
	count(parts) == 2
	regex.match(digits_pattern, parts[1])
	prefix := to_number(parts[1])
	prefix <= 32
}

cidr_mask(0) := 0

cidr_mask(prefix) := m if {
	prefix > 0
	m := bits.lsh(bits.rsh(4294967295, 32 - prefix), 32 - prefix)
}

# is_canonical_cidr holds when the address portion of the CIDR is exactly its
# own network address (i.e. the host bits are zero), matching the bash
# predecessor's `cidr_range` validity check.
is_canonical_cidr(cidr) if {
	parts := split(cidr, "/")
	count(parts) == 2
	ip := ipv4_to_int(parts[0])
	prefix := cidr_prefix(cidr)
	m := cidr_mask(prefix)
	bits.and(ip, m) == ip
}

is_asn(value) if {
	regex.match(digits_pattern, value)
	n := to_number(value)
	n >= 1
	n <= 4294967295
}

is_port(value) if {
	regex.match(digits_pattern, value)
	n := to_number(value)
	n >= 1
	n <= 65535
}

fact_ok(facts, key) if {
	is_string(facts[key])
	count(facts[key]) > 0
}

docs := input

doc_data(i) := docs[i].contents.data

doc_path(i) := docs[i].path

is_flux_configmap(i) if {
	d := docs[i].contents
	d.apiVersion == "v1"
	d.kind == "ConfigMap"
	d.metadata.name == "cluster-topology"
	d.metadata.namespace == "flux-system"
}

# has_flat_string_data gates every fact-level check below, mirroring the bash
# predecessor's `continue` after a malformed `data` map.
has_flat_string_data(i) if {
	d := docs[i].contents
	is_object(d.data)
	every _, v in d.data {
		is_string(v)
	}
}

all_facts_present(i) if {
	has_flat_string_data(i)
	facts := doc_data(i)
	every key in required_keys {
		fact_ok(facts, key)
	}
}

dns_entries(facts) := split(facts.CLUSTER_DNS, ",")

# --- per-document structural checks -----------------------------------------

deny contains msg if {
	some i, _ in docs
	not is_flux_configmap(i)
	msg := sprintf("%s: must be the flux-system/cluster-topology ConfigMap", [doc_path(i)])
}

deny contains msg if {
	some i, _ in docs
	not has_flat_string_data(i)
	msg := sprintf("%s: data must be a flat string-to-string map", [doc_path(i)])
}

deny contains msg if {
	some i, _ in docs
	has_flat_string_data(i)
	facts := doc_data(i)
	some key in required_keys
	not fact_ok(facts, key)
	msg := sprintf("%s: %s is required", [doc_path(i), key])
}

# --- per-document fact checks (only once every required fact is present) ---

deny contains msg if {
	some i, _ in docs
	all_facts_present(i)
	facts := doc_data(i)
	some key in {"API_SERVER_IP", "ROUTER_IP"}
	not ipv4_to_int(facts[key])
	msg := sprintf("%s: %s must be an IPv4 address", [doc_path(i), key])
}

deny contains msg if {
	some i, _ in docs
	all_facts_present(i)
	facts := doc_data(i)
	some entry in dns_entries(facts)
	count(entry) == 0
	msg := sprintf("%s: CLUSTER_DNS entries must not be empty", [doc_path(i)])
}

deny contains msg if {
	some i, _ in docs
	all_facts_present(i)
	facts := doc_data(i)
	some entry in dns_entries(facts)
	count(entry) > 0
	not ipv4_to_int(entry)
	msg := sprintf("%s: each CLUSTER_DNS entry must be an IPv4 address", [doc_path(i)])
}

deny contains msg if {
	some i, _ in docs
	all_facts_present(i)
	facts := doc_data(i)
	is_canonical_cidr(facts.SERVICE_CIDR)
	some entry in dns_entries(facts)
	ipv4_to_int(entry)
	not net.cidr_contains(facts.SERVICE_CIDR, entry)
	msg := sprintf("%s: each CLUSTER_DNS entry must be in SERVICE_CIDR", [doc_path(i)])
}

deny contains msg if {
	some i, _ in docs
	all_facts_present(i)
	facts := doc_data(i)
	some key in cidr_keys
	not is_canonical_cidr(facts[key])
	msg := sprintf("%s: %s must be a canonical IPv4 CIDR", [doc_path(i), key])
}

deny contains msg if {
	some i, _ in docs
	all_facts_present(i)
	facts := doc_data(i)
	not is_port(facts.API_SERVER_PORT)
	msg := sprintf("%s: API_SERVER_PORT must be between 1 and 65535", [doc_path(i)])
}

deny contains msg if {
	some i, _ in docs
	all_facts_present(i)
	facts := doc_data(i)
	some key in {"BGP_GATEWAY_ASN", "BGP_CILIUM_ASN"}
	not is_asn(facts[key])
	msg := sprintf("%s: %s must be a BGP ASN", [doc_path(i), key])
}

deny contains msg if {
	some i, _ in docs
	all_facts_present(i)
	facts := doc_data(i)
	facts.BGP_GATEWAY_ASN == facts.BGP_CILIUM_ASN
	msg := sprintf("%s: BGP_GATEWAY_ASN and BGP_CILIUM_ASN must differ", [doc_path(i)])
}

deny contains msg if {
	some i, _ in docs
	all_facts_present(i)
	facts := doc_data(i)
	is_canonical_cidr(facts.K8S_NODE_CIDR)
	ipv4_to_int(facts.API_SERVER_IP)
	not net.cidr_contains(facts.K8S_NODE_CIDR, facts.API_SERVER_IP)
	msg := sprintf("%s: API_SERVER_IP must be in K8S_NODE_CIDR", [doc_path(i)])
}

deny contains msg if {
	some i, _ in docs
	all_facts_present(i)
	facts := doc_data(i)
	is_canonical_cidr(facts.K8S_NODE_CIDR)
	ipv4_to_int(facts.ROUTER_IP)
	not net.cidr_contains(facts.K8S_NODE_CIDR, facts.ROUTER_IP)
	msg := sprintf("%s: ROUTER_IP must be in K8S_NODE_CIDR", [doc_path(i)])
}

deny contains msg if {
	some i, _ in docs
	all_facts_present(i)
	facts := doc_data(i)
	is_canonical_cidr(facts.LB_RANGE)
	is_canonical_cidr(facts.K8S_NODE_CIDR)
	net.cidr_intersects(facts.LB_RANGE, facts.K8S_NODE_CIDR)
	msg := sprintf("%s: LB_RANGE must not overlap K8S_NODE_CIDR", [doc_path(i)])
}

deny contains msg if {
	some i, _ in docs
	all_facts_present(i)
	facts := doc_data(i)
	is_canonical_cidr(facts.CILIUM_NATIVE_ROUTING_CIDR)
	some key in {"K8S_NODE_CIDR", "CILIUM_POD_CIDR", "LB_RANGE"}
	is_canonical_cidr(facts[key])
	not net.cidr_contains(facts.CILIUM_NATIVE_ROUTING_CIDR, facts[key])
	msg := sprintf("%s: CILIUM_NATIVE_ROUTING_CIDR must contain %s", [doc_path(i), key])
}

# --- cross-document contract (only once every document is well-formed) -----

deny contains msg if {
	some i, _ in docs
	some j, _ in docs
	i < j
	all_facts_present(i)
	all_facts_present(j)
	doc_data(i).CLUSTER_NAME == doc_data(j).CLUSTER_NAME
	msg := "topology contract: CLUSTER_NAME values must be unique"
}

deny contains msg if {
	some i, _ in docs
	some j, _ in docs
	i < j
	all_facts_present(i)
	all_facts_present(j)
	some first_kind, first_key in range_kind
	some second_kind, second_key in range_kind
	first_cidr := doc_data(i)[first_key]
	second_cidr := doc_data(j)[second_key]
	is_canonical_cidr(first_cidr)
	is_canonical_cidr(second_cidr)
	net.cidr_intersects(first_cidr, second_cidr)
	msg := sprintf(
		"topology contract: %s must not overlap %s between %s and %s",
		[first_kind, second_kind, doc_data(i).CLUSTER_NAME, doc_data(j).CLUSTER_NAME],
	)
}
