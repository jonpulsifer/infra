resource "unifi_network" "starlink" {
  name    = "starlink"
  purpose = "wan"

  wan_networkgroup = "WAN"
  wan_type         = "dhcp"
  wan_type_v6      = "disabled"
  wan_dns          = []

  internet_access_enabled      = true
  intra_network_access_enabled = false
}

data "vault_generic_secret" "ddns_edge_pulsifer_ca" {
  path = "home/unifi/google_ddns/edge.pulsifer.ca"
}

resource "unifi_dynamic_dns" "edge" {
  service  = "dyndns"
  server   = "domains.google.com"
  login    = data.vault_generic_secret.ddns_edge_pulsifer_ca.data["username"]
  password = data.vault_generic_secret.ddns_edge_pulsifer_ca.data["password"]

  host_name = "edge.pulsifer.ca"
}
