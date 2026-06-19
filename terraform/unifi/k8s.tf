locals {
  node_cidr = "10.3.0.1/26"
  static_records = {
    "erx" : cidrhost(local.lab_cidr, 5)
    "k8s" : cidrhost(local.node_cidr, 10)
    "nuc" : cidrhost(local.node_cidr, 13)
    "k8s" : cidrhost(local.node_cidr, 10)
    "800g2" : cidrhost(local.node_cidr, 11)
    "riptide" : cidrhost(local.node_cidr, 12)
    "optiplex" : cidrhost(local.node_cidr, 10)
  }
}

resource "unifi_network" "k8s" {
  name   = "Kubernetes"
  subnet = local.node_cidr
  vlan   = 8

  dhcp_server = {
    enabled     = true
    leasetime   = local.one_day
    start       = cidrhost(local.node_cidr, 2)
    stop        = cidrhost(local.node_cidr, 62)
    dns_enabled = true
    dns_servers = ["10.2.0.20"]
    boot = {
      enabled = false
    }
  }

  dhcp_relay = {
    enabled = false
  }
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
