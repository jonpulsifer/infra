locals {
  # UniFi subnets take the gateway-host (.1) form; cidrhost() ignores host bits.
  node_cidr = "${cidrhost(local.topology.K8S_NODE_CIDR, 1)}/${split("/", local.topology.K8S_NODE_CIDR)[1]}"
  lb_cidr   = local.topology.LB_RANGE

  # Hostname to address for every node, from the topology ConfigMap. Each node
  # also needs its MAC under `k8s` in clients.yaml.
  node_addresses = jsondecode(local.topology.NODE_ADDRESSES)

  static_records = merge(
    {
      "erx" = cidrhost(local.lab_cidr, 5)
      "k8s" = local.topology.API_SERVER_IP
      "nuc" = cidrhost(local.node_cidr, 13)
    },
    local.node_addresses,
  )
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
    dns_servers = local.dns_servers
    tftp_server = local.lab.hosts.spore
    boot = {
      enabled  = true
      server   = local.lab.hosts.spore
      filename = "boot/ipxe.efi"
    }
  }

}

# A node keeps its address across a reinstall because the reservation is on
# its MAC. Reserved inside the DHCP pool; the controller excludes reserved
# addresses from it. A node in NODE_ADDRESSES with no `k8s` entry in
# clients.yaml fails the plan on the index below.
resource "unifi_client" "k8s_nodes" {
  for_each = local.node_addresses

  mac        = local.clients.k8s[each.key].mac
  name       = each.key
  fixed_ip   = each.value
  network_id = unifi_network.k8s.id
  note       = "terraform managed - folly Kubernetes node"

  # The controller already knows these MACs.
  allow_existing         = true
  skip_forget_on_destroy = true
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
}
