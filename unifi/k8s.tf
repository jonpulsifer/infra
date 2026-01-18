locals {
  node_cidr = "10.3.0.1/26"
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

resource "unifi_network" "k8s" {
  name          = "Kubernetes"
  network_group = "LAN"
  purpose       = "corporate"
  subnet        = local.node_cidr

  dhcp_enabled       = true
  dhcp_lease         = local.one_day
  dhcp_relay_enabled = false
  dhcp_start         = cidrhost(local.node_cidr, 2)
  dhcp_stop          = cidrhost(local.node_cidr, 62)
  dhcp_dns           = ["10.2.0.20"]
  dhcpd_boot_enabled = false
  vlan_id            = 8
}

resource "cloudflare_dns_record" "k8s_remote_dns" {
  for_each = local.static_records

  zone_id = data.cloudflare_zone.lab.zone_id
  name    = "${each.key}.${local.lab_domain}"
  content = each.value
  type    = "A"
  ttl     = 1
  comment = "terraform managed"
  proxied = false
  # tags    = ["terraform-managed"]
}
