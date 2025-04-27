locals {
  dishy_cidr = "192.168.100.0/24"
}

resource "unifi_network" "starlink" {
  name    = "Starlink"
  purpose = "wan"

  wan_networkgroup = "WAN"
  wan_type         = "dhcp"
  # wan_type_v6         = "slaac"
  wan_dhcp_v6_pd_size = 56
  wan_dns             = ["1.1.1.1", "1.0.0.1"]

  internet_access_enabled      = true
  intra_network_access_enabled = false

  lifecycle {
    # provider doesn't support slaac
    ignore_changes = [
      wan_type_v6,
    ]
  }
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
