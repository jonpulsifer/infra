locals {
  # UniFi subnets take the gateway-host (.1) form; cidrhost() ignores host bits.
  node_cidr = "${cidrhost(local.topology.K8S_NODE_CIDR, 1)}/${split("/", local.topology.K8S_NODE_CIDR)[1]}"
  lb_cidr   = local.topology.LB_RANGE
  dhcp_cidr = local.topology.K8S_DHCP_CIDR

  machines = yamldecode(file("${path.module}/../../../../clusters/folly/inventory/machines.yaml")).machines

  # Hostname to address for every node: the export's active and failed
  # machines, which clusters/folly/talos treats as nodes.
  node_addresses = {
    for node, m in local.machines : node => m.address
    if contains(["active", "failed"], try(m.status, "active")) && try(m.address, null) != null
  }

  # A planned machine is not a node yet, or reinstalls. Its DNS record comes
  # from the export's address, so a reprovisioned node keeps its name.
  planned_addresses = {
    for node, m in local.machines : node => m.address
    if try(m.status, "active") == "planned" && try(m.address, null) != null
  }

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

  # Each node's Talos config carries its address statically, so the pool
  # serves only machines that netboot: firmware PXE, HookOS, and a fresh
  # install's first boot before it applies its config. It is K8S_DHCP_CIDR,
  # which holds no node's address.
  dhcp_server = {
    enabled   = true
    leasetime = local.one_day
    start     = cidrhost(local.dhcp_cidr, 1)
    stop      = cidrhost(local.dhcp_cidr, -2)
    dns = {
      enabled = true
      servers = local.dns_servers
    }
    # A machine netboots here, from the anchors on their bootstrap addresses
    # through the policy kubernetes_to_boot in firewall.tf: the offer names
    # the boot VIP and the signed iPXE's filename. The resolvers above are the
    # anchors' CoreDNS, which answers enroll.lolwtf.ca with the boot VIP.
    tftp_server = local.boot_vip
    boot        = local.boot_option
  }

  lifecycle {
    precondition {
      condition = alltrue([
        for node, m in local.machines : cidrhost("${m.address}/${split("/", local.dhcp_cidr)[1]}", 0) != cidrhost(local.dhcp_cidr, 0)
        if try(m.address, null) != null
      ])
      error_message = "A machine's address in clusters/folly/inventory/machines.yaml is inside K8S_DHCP_CIDR, the Kubernetes network's DHCP pool."
    }
  }
}

# The nodes' DHCP reservations leave state and stay on the controller, as
# skip_forget_on_destroy kept them: an AMT in DHCP mode shares its node's MAC
# and still leases the node's address there. Talos needs none of them.
removed {
  from = unifi_client.k8s_nodes

  lifecycle {
    destroy = false
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
}
