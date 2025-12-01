locals {
  node_cidr = "10.3.0.0/26"
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
  domain_name   = local.lab_domain
  network_group = "LAN"
  purpose       = "corporate"
  subnet        = local.node_cidr
  # wan_gateway   = "0.0.0.0"

  dhcp_enabled     = true
  dhcp_lease       = local.one_day
  dhcp_start       = cidrhost(local.node_cidr, 2)
  dhcp_stop        = cidrhost(local.node_cidr, 62)
  dhcp_v6_start    = "::2"
  dhcp_v6_stop     = "::7d1"
  ipv6_pd_start    = "::2"
  ipv6_pd_stop     = "::7d1"
  ipv6_ra_priority = "high"
  multicast_dns    = true
  igmp_snooping    = true
  vlan_id          = 8
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
