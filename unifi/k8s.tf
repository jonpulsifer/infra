locals {
  node_cidr = "10.3.0.0/24"
  pod_cidr  = "10.100.0.0/16"
}

resource "unifi_static_route" "k8s" {
  type     = "nexthop-route"
  network  = local.node_cidr
  name     = "k8s"
  distance = 1
  next_hop = "10.2.0.5"
}

resource "unifi_firewall_group" "k8s" {
  name = "k8s"
  type = "address-group"
  members = [
    local.node_cidr,
    local.pod_cidr,
    # pod network
    # "10.100.0.0/24",
    # "10.100.1.0/24",
    # "10.100.2.0/24",
    # "10.100.3.0/24",
  ]
}

resource "unifi_firewall_rule" "allow_fml_to_k8s" {
  name       = "Allow ${unifi_network.fml.name} to k8s nodes"
  action     = "accept"
  ruleset    = "LAN_IN"
  rule_index = "2100"

  protocol = "all"

  src_network_type = "NETv4"
  src_network_id   = unifi_network.fml.id

  dst_network_type       = "NETv4"
  dst_firewall_group_ids = [unifi_firewall_group.k8s.id]
}
