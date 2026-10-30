locals {
  # UniFi subnets take the gateway-host (.1) form; cidrhost() ignores host bits.
  node_cidr = "${cidrhost(local.topology.K8S_NODE_CIDR, 1)}/${split("/", local.topology.K8S_NODE_CIDR)[1]}"
  lb_cidr   = local.topology.LB_RANGE

  machines = yamldecode(file("${path.module}/../../../../clusters/folly/inventory/machines.yaml")).machines

  # Hostname to address for every node: the export's active and failed
  # machines, which clusters/folly/talos treats as nodes.
  node_addresses = {
    for node, m in local.machines : node => m.address
    if contains(["active", "failed"], try(m.status, "active")) && try(m.address, null) != null
  }

  # A planned machine is not a node yet, or reinstalls. Its reservation and
  # DNS record come from the export's address, once it has a MAC and a
  # switch port, so a reprovisioned node keeps its name.
  planned_addresses = {
    for node, m in local.machines : node => m.address
    if try(m.status, "active") == "planned" && try(m.mac, null) != null && try(m.switch_port, null) != null && try(m.address, null) != null
  }
  reservations = merge(local.planned_addresses, local.node_addresses)

  static_records = merge(
    {
      "erx" = cidrhost(local.anchor_cidr, 5)
      "k8s" = local.topology.API_SERVER_IP
    },
    local.planned_addresses,
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
  ipv6 = {
    interface_type = "none"
  }

  dhcp_server = {
    enabled   = true
    leasetime = local.one_day
    start     = cidrhost(local.node_cidr, 2)
    stop      = cidrhost(local.node_cidr, 62)
    dns = {
      enabled = true
      servers = local.dns_servers
    }
    # A known node netboots here, from the anchors on their bootstrap addresses
    # through the policy kubernetes_to_boot in firewall.tf. The resolvers above
    # are the anchors' CoreDNS, which answers enroll.lolwtf.ca with the boot VIP.
    tftp_server = local.boot_vip
    boot        = local.boot_option
  }

}

# A node keeps its address across a reinstall because the reservation is on
# its MAC. Reserved inside the DHCP pool; the controller excludes reserved
# addresses from it. A node whose export entry has no MAC fails the
# plan on the index below. A planned machine with a MAC, a switch port and an
# address gets one from the export; one without them gets none.
resource "unifi_client" "k8s_nodes" {
  for_each = { for node, ip in local.reservations : node => ip if try(local.machines[node].mac, "") != null }

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
