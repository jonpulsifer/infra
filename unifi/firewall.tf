resource "unifi_firewall_group" "rfc1918" {
  name    = "RFC1918"
  type    = "address-group"
  members = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]
}

resource "unifi_firewall_rule" "allow_established" {
  name              = "Allow Established/Related Sessions"
  action            = "accept"
  ruleset           = "LAN_IN"
  rule_index        = "20000"
  protocol          = "all"
  state_established = true
  state_related     = true
}

resource "unifi_firewall_rule" "drop_invalid" {
  name          = "Drop Invalid State"
  action        = "drop"
  ruleset       = "LAN_IN"
  rule_index    = 20001
  protocol      = "all"
  state_invalid = true
}

resource "unifi_firewall_rule" "allow_fml_to_lab" {
  name       = "Allow ${local.fml_cidr} to ${local.lab_cidr}"
  action     = "accept"
  ruleset    = "LAN_IN"
  rule_index = "20002"

  protocol = "all"

  src_network_type = "NETv4"
  src_network_id   = unifi_network.fml.id

  dst_network_type = "NETv4"
  dst_network_id   = unifi_network.lab.id
}

# resource "unifi_firewall_rule" "allow_lab_to_fml" {
#   name       = "Allow ${unifi_network.lab.name} to ${unifi_network.fml.name}"
#   action     = "accept"
#   ruleset    = "LAN_IN"
#   rule_index = "20003"

#   protocol = "all"

#   src_network_type = "NETv4"
#   src_network_id   = unifi_network.lab.id

#   dst_network_type = "NETv4"
#   dst_network_id   = unifi_network.fml.id
# }

resource "unifi_firewall_rule" "drop_all_rfc1918" {
  name    = "Drop all other inter RFC1918 traffic"
  action  = "drop"
  enabled = false
  ruleset = "LAN_IN"

  rule_index = 40000

  protocol               = "all"
  dst_firewall_group_ids = [unifi_firewall_group.rfc1918.id]
}

# resource "unifi_firewall_rule" "drop_all" {
#   name       = "Drop All"
#   action     = "drop"
#   ruleset    = "LAN_IN"
#   rule_index = 4001
#   protocol   = "all"
# }
