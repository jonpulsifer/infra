resource "unifi_static_route" "k8s" {
  type     = "nexthop-route"
  network  = "10.3.0.0/24"
  name     = "k8s"
  distance = 1
  next_hop = "10.2.0.5"
}

resource "unifi_firewall_rule" "allow_fml_to_k8s" {
  name       = "Allow ${unifi_network.fml.name} to ${unifi_network.lab.name}"
  action     = "accept"
  ruleset    = "LAN_IN"
  rule_index = "2100"

  protocol = "all"

  src_network_type = "NETv4"
  src_network_id   = unifi_network.fml.id

  dst_network_type = "NETv4"
  dst_address      = "10.3.0.0/24"
}
