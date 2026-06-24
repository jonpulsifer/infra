locals {
  node_cidr = "10.3.0.1/26"
  lb_cidr   = "10.3.0.64/26"
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
    dns_servers = ["10.2.0.20"]
    tftp_server = "10.2.0.11"
    boot = {
      enabled  = true
      server   = "10.2.0.11"
      filename = "boot/ipxe.efi"
    }
  }

}

# Cilium LoadBalancer VIP range (10.3.0.64/26) lives outside the UDM's
# connected k8s network (10.3.0.0/26) and is announced per-VIP via BGP from the
# cluster nodes. The /32s land in FRR's BGP RIB but UniFi does not reliably
# program BGP-learned prefixes into the forwarding/firewall path — only a
# configured static route makes the range routable (confirmed: manually adding
# /32 statics was the one state where LB VIPs were reachable). This codifies
# that workaround as a single /26 nexthop route so the whole pool is routable
# and firewall-plumbed. The longer-prefix BGP /32s still win for ECMP when they
# are programmed; this is the floor. Long-term, Cilium cluster mesh replaces it.
#
# next_hop is a single node, so it is a soft SPOF for the static fallback path;
# externalTrafficPolicy: Cluster means that node forwards to wherever the
# backend actually lives.
resource "unifi_static_route" "k8s_lb" {
  type     = "nexthop-route"
  network  = local.lb_cidr
  next_hop = cidrhost(local.node_cidr, 10) # optiplex / k8s API VIP
  name     = "Kubernetes LB"
  distance = 1
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
