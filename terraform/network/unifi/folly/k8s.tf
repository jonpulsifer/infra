locals {
  # node_cidr keeps the gateway-host (.1) form the UniFi network subnet expects;
  # cidrhost() masks host bits so the static_records/dhcp ranges below are unchanged.
  node_cidr = "${cidrhost(local.topology.K8S_NODE_CIDR, 1)}/${split("/", local.topology.K8S_NODE_CIDR)[1]}"
  lb_cidr   = local.topology.LB_RANGE
  static_records = {
    "erx"      = cidrhost(local.lab_cidr, 5)
    "k8s"      = cidrhost(local.node_cidr, 10)
    "nuc"      = cidrhost(local.node_cidr, 13)
    "800g2"    = cidrhost(local.node_cidr, 11)
    "riptide"  = cidrhost(local.node_cidr, 12)
    "optiplex" = cidrhost(local.node_cidr, 10)
  }
}

resource "unifi_network" "k8s" {
  name               = "Kubernetes"
  subnet             = local.node_cidr
  vlan               = 8
  domain_name        = local.lab_domain
  setting_preference = "manual"
  auto_scale         = false
  lte_lan            = false
  network_isolation  = true
  multicast_dns      = false

  dhcp_server = {
    enabled     = true
    leasetime   = local.one_day
    start       = cidrhost(local.node_cidr, 2)
    stop        = cidrhost(local.node_cidr, 62)
    dns_enabled = true
    dns_servers = ["10.2.0.10"]
    tftp_server = "10.2.0.11"
    boot = {
      enabled  = true
      server   = "10.2.0.11"
      filename = "boot/ipxe.efi"
    }
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
