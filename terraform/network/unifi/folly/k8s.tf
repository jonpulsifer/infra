locals {
  # UniFi subnets take the gateway-host (.1) form; cidrhost() ignores host bits.
  node_cidr = "${cidrhost(local.topology.K8S_NODE_CIDR, 1)}/${split("/", local.topology.K8S_NODE_CIDR)[1]}"
  lb_cidr   = local.topology.LB_RANGE

  # Hostname to address for every node, from the topology ConfigMap. Each node
  # also needs an entry in the hardware inventory.
  node_addresses = jsondecode(local.topology.NODE_ADDRESSES)
  machines       = yamldecode(file("${path.module}/../../../../clusters/folly/inventory/machines.yaml")).machines

  static_records = merge(
    {
      "erx" = cidrhost(local.anchor_cidr, 5)
      "k8s" = local.topology.API_SERVER_IP
    },
    local.node_addresses,
  )
}

resource "unifi_network" "k8s" {
  name                = "Kubernetes"
  subnet              = local.node_cidr
  vlan                = 8
  domain_name         = local.lab_domain
  setting_preference  = "manual"
  auto_scale          = false
  lte_lan             = false
  network_isolation   = true
  multicast_dns       = false
  ipv6_interface_type = "none"

  dhcp_server = {
    enabled     = true
    leasetime   = local.one_day
    start       = cidrhost(local.node_cidr, 2)
    stop        = cidrhost(local.node_cidr, 62)
    dns_enabled = true
    dns_servers = local.dns_servers
    # A known node netboots here, from the anchors on their bootstrap addresses
    # through the policy kubernetes_to_boot in firewall.tf. The resolvers above
    # are the anchors' CoreDNS, which answers enroll.lolwtf.ca with the boot VIP.
    tftp_server = local.boot_vip
    boot        = local.boot_option
  }

}

# A node keeps its address across a reinstall because the reservation is on
# its MAC. Reserved inside the DHCP pool; the controller excludes reserved
# addresses from it. A node in NODE_ADDRESSES with no inventory entry fails the
# plan on the index below; a planned machine with no MAC yet gets no reservation.
resource "unifi_client" "k8s_nodes" {
  for_each = { for node, ip in local.node_addresses : node => ip if try(local.machines[node].mac, "") != null }

  # No network_id: the provider sends it as a Virtual Network Override, which
  # the switch enforces as a MAC-based VLAN on every port, whatever RADIUS
  # assigns. RADIUS and the node ports put a node on the Kubernetes VLAN.
  mac      = local.machines[each.key].mac
  name     = each.key
  fixed_ip = each.value
  note     = "terraform managed - folly Kubernetes node"

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
