locals {
  node_cidr = "10.3.0.0/24"
  pod_cidr  = "10.100.0.0/20"
  static_records = {
    "erx" : cidrhost(local.lab_cidr, 5)
    "k8s" : cidrhost(local.node_cidr, 10)
    "nuc" : cidrhost(local.node_cidr, 10)
    "k8s" : cidrhost(local.node_cidr, 10)
    "800g2" : cidrhost(local.node_cidr, 11)
    "riptide" : cidrhost(local.node_cidr, 12)
    "optiplex" : cidrhost(local.node_cidr, 13)
  }
}

resource "cloudflare_record" "k8s_remote_dns" {
  for_each = local.static_records

  zone_id   = data.cloudflare_zone.lab.id
  name      = each.key
  content   = each.value
  type      = "A"
  ttl       = 1
  comment   = "terraform managed"
  # tags    = ["terraform-managed"]
}

resource "unifi_static_route" "k8s_nodes" {
  type     = "nexthop-route"
  network  = local.node_cidr
  name     = "Kubernetes Nodes"
  distance = 1
  next_hop = cidrhost(local.lab_cidr, 5)
}

resource "unifi_static_route" "k8s_pods" {
  type     = "nexthop-route"
  network  = local.pod_cidr
  name     = "Kubernetes Pods"
  distance = 2
  next_hop = cidrhost(local.lab_cidr, 5)
}



resource "unifi_firewall_group" "k8s" {
  name = "Kubernetes Network"
  type = "address-group"
  members = [
    local.node_cidr,
    local.pod_cidr,
  ]
}

resource "unifi_firewall_rule" "allow_fml_to_k8s" {
  name       = "Allow ${local.fml_cidr} to ${local.node_cidr} and ${local.pod_cidr}"
  action     = "accept"
  ruleset    = "LAN_IN"
  rule_index = "20003"

  protocol = "all"

  src_network_type = "NETv4"
  src_network_id   = unifi_network.fml.id

  dst_network_type       = "NETv4"
  dst_firewall_group_ids = [unifi_firewall_group.k8s.id]
}
