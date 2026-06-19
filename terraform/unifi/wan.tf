locals {
  dishy_cidr = "192.168.100.0/24"
}

resource "unifi_wan" "starlink" {
  name = "Starlink"
  type = "dhcp"
}

resource "unifi_static_route" "starlink" {
  type      = "interface-route"
  interface = "WAN"
  network   = local.dishy_cidr
  name      = "Starlink"
  distance  = 1
}

