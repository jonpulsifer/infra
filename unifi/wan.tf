locals {
  dishy_cidr = "192.168.100.0/24"
}

resource "unifi_network" "starlink" {
  name    = "Starlink"
  purpose = "wan"

  network_group = "LAN"

  dhcp_enabled       = false
  dhcp_relay_enabled = false
  dhcpd_boot_enabled = false
}

resource "unifi_static_route" "starlink" {
  type      = "interface-route"
  interface = "WAN"
  network   = local.dishy_cidr
  name      = "Starlink"
  distance  = 1
}

data "vault_generic_secret" "ddns_edge_pulsifer_ca" {
  path = "home/unifi/google_ddns/edge.pulsifer.ca"
}

# resource "unifi_dynamic_dns" "edge" {
#   service  = "dyndns"
#   server   = "domains.google.com"
#   login    = data.vault_generic_secret.ddns_edge_pulsifer_ca.data["username"]
#   password = data.vault_generic_secret.ddns_edge_pulsifer_ca.data["password"]

#   host_name = "edge.pulsifer.ca"
# }
