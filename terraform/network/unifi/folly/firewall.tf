data "unifi_firewall_zone" "internal" {
  name = "Internal"
}

data "unifi_firewall_zone" "external" {
  name = "External"
}

data "unifi_firewall_zone" "hotspot" {
  name = "Hotspot"
}

data "unifi_firewall_zone" "vpn" {
  name = "Vpn"
}

data "unifi_firewall_zone" "gateway" {
  name = "Gateway"
}

data "unifi_network" "nest" {
  name = "nest.pulsifer.ca"
}

resource "unifi_firewall_zone" "lab" {
  name = "Lab"

  network_ids = [
    unifi_network.lab.id,
    unifi_network.k8s.id,
  ]
}

# A custom zone blocks every other zone by default except External and Gateway,
# so the bootstrap policies at the end close those two.
resource "unifi_firewall_zone" "bootstrap" {
  name = "Bootstrap"

  network_ids = [
    unifi_network.bootstrap.id,
  ]
}

resource "unifi_firewall_group" "teleport_cidr" {
  name    = "Teleport CIDR"
  type    = "address-group"
  members = ["192.168.2.0/24"]
}

# Source zone comes from the ingress interface and Lab -> Vpn ends in a DROP, so every source CIDR matters.
# As destinations, LB and pod CIDRs are in no zone and fall through to -> WAN, which accepts.
locals {
  folly_k8s_cidrs = [
    local.topology.K8S_NODE_CIDR,
    local.lb_range,
    local.topology.CILIUM_POD_CIDR,
  ]
  nest_k8s_cidrs = [
    local.offsite_topology.K8S_NODE_CIDR,
    local.offsite_topology.LB_RANGE,
    local.offsite_topology.CILIUM_POD_CIDR,
  ]
}

resource "unifi_firewall_policy" "allow_established_related_internal" {
  name                 = "Allow Established/Related Internal"
  action               = "ALLOW"
  protocol             = "all"
  ip_version           = "IPV4"
  create_allow_respond = false
  enabled              = true
  logging              = false

  source = {
    matching_target    = "ANY"
    port_matching_type = "ANY"
    zone_id            = data.unifi_firewall_zone.internal.id
  }

  destination = {
    matching_target    = "ANY"
    port_matching_type = "ANY"
    zone_id            = data.unifi_firewall_zone.internal.id
  }
}

resource "unifi_firewall_policy" "allow_established_related_hotspot" {
  name                 = "Allow Established/Related Hotspot"
  action               = "ALLOW"
  protocol             = "all"
  ip_version           = "IPV4"
  create_allow_respond = false
  enabled              = true
  logging              = false

  source = {
    matching_target    = "ANY"
    port_matching_type = "ANY"
    zone_id            = data.unifi_firewall_zone.internal.id
  }

  destination = {
    matching_target    = "ANY"
    port_matching_type = "ANY"
    zone_id            = data.unifi_firewall_zone.hotspot.id
  }
}

resource "unifi_firewall_policy" "allow_established_related_external" {
  name                 = "Allow Established/Related External"
  action               = "ALLOW"
  protocol             = "all"
  ip_version           = "IPV4"
  create_allow_respond = false
  enabled              = true
  logging              = false

  source = {
    matching_target    = "ANY"
    port_matching_type = "ANY"
    zone_id            = data.unifi_firewall_zone.internal.id
  }

  destination = {
    matching_target    = "ANY"
    port_matching_type = "ANY"
    zone_id            = data.unifi_firewall_zone.external.id
  }
}

resource "unifi_firewall_policy" "allow_established_related_vpn" {
  name                 = "Allow Established/Related VPN"
  action               = "ALLOW"
  protocol             = "all"
  ip_version           = "IPV4"
  create_allow_respond = false
  enabled              = true
  logging              = false

  source = {
    matching_target    = "ANY"
    port_matching_type = "ANY"
    zone_id            = data.unifi_firewall_zone.internal.id
  }

  destination = {
    matching_target    = "ANY"
    port_matching_type = "ANY"
    zone_id            = data.unifi_firewall_zone.vpn.id
  }
}

resource "unifi_firewall_policy" "drop_invalid_internal" {
  name                 = "Drop Invalid Internal"
  action               = "BLOCK"
  protocol             = "all"
  ip_version           = "IPV4"
  create_allow_respond = false
  enabled              = true
  logging              = false

  source = {
    matching_target    = "ANY"
    port_matching_type = "ANY"
    zone_id            = data.unifi_firewall_zone.internal.id
  }

  destination = {
    matching_target    = "ANY"
    port_matching_type = "ANY"
    zone_id            = data.unifi_firewall_zone.internal.id
  }
}

resource "unifi_firewall_policy" "drop_invalid_hotspot" {
  name                 = "Drop Invalid Hotspot"
  action               = "BLOCK"
  protocol             = "all"
  ip_version           = "IPV4"
  create_allow_respond = false
  enabled              = true
  logging              = false

  source = {
    matching_target    = "ANY"
    port_matching_type = "ANY"
    zone_id            = data.unifi_firewall_zone.internal.id
  }

  destination = {
    matching_target    = "ANY"
    port_matching_type = "ANY"
    zone_id            = data.unifi_firewall_zone.hotspot.id
  }
}

resource "unifi_firewall_policy" "drop_invalid_external" {
  name                 = "Drop Invalid External"
  action               = "BLOCK"
  protocol             = "all"
  ip_version           = "IPV4"
  create_allow_respond = false
  enabled              = true
  logging              = false

  source = {
    matching_target    = "ANY"
    port_matching_type = "ANY"
    zone_id            = data.unifi_firewall_zone.internal.id
  }

  destination = {
    matching_target    = "ANY"
    port_matching_type = "ANY"
    zone_id            = data.unifi_firewall_zone.external.id
  }
}

resource "unifi_firewall_policy" "drop_invalid_vpn" {
  name                 = "Drop Invalid VPN"
  action               = "BLOCK"
  protocol             = "all"
  ip_version           = "IPV4"
  create_allow_respond = false
  enabled              = true
  logging              = false

  source = {
    matching_target    = "ANY"
    port_matching_type = "ANY"
    zone_id            = data.unifi_firewall_zone.internal.id
  }

  destination = {
    matching_target    = "ANY"
    port_matching_type = "ANY"
    zone_id            = data.unifi_firewall_zone.vpn.id
  }
}

resource "unifi_firewall_policy" "internal_to_lab" {
  name                 = "Allow Internal to Lab"
  action               = "ALLOW"
  protocol             = "all"
  ip_version           = "BOTH"
  create_allow_respond = true
  enabled              = true
  logging              = false

  source = {
    matching_target    = "ANY"
    port_matching_type = "ANY"
    zone_id            = data.unifi_firewall_zone.internal.id
  }

  destination = {
    matching_target    = "ANY"
    port_matching_type = "ANY"
    zone_id            = unifi_firewall_zone.lab.id
  }
}

resource "unifi_firewall_policy" "lab_to_lab" {
  name                 = "Allow Lab to Lab"
  action               = "ALLOW"
  protocol             = "all"
  ip_version           = "BOTH"
  create_allow_respond = true
  enabled              = true
  logging              = false

  source = {
    matching_target    = "ANY"
    port_matching_type = "ANY"
    zone_id            = unifi_firewall_zone.lab.id
  }

  destination = {
    matching_target    = "ANY"
    port_matching_type = "ANY"
    zone_id            = unifi_firewall_zone.lab.id
  }
}

resource "unifi_firewall_policy" "prometheus_windows_exporters" {
  name                 = "Allow Prometheus Windows Exporters"
  action               = "ALLOW"
  protocol             = "tcp"
  ip_version           = "BOTH"
  create_allow_respond = true
  enabled              = true
  logging              = false

  source = {
    matching_target    = "ANY"
    port_matching_type = "ANY"
    zone_id            = unifi_firewall_zone.lab.id
  }

  destination = {
    matching_target    = "ANY"
    port               = "9182"
    port_matching_type = "SPECIFIC"
    zone_id            = data.unifi_firewall_zone.internal.id
  }
}

# OhmGraphite sensors listen on their own port, outside windows_exporter's.
resource "unifi_firewall_policy" "prometheus_windows_sensors" {
  name                 = "Allow Prometheus Windows Sensors"
  action               = "ALLOW"
  protocol             = "tcp"
  ip_version           = "BOTH"
  create_allow_respond = true
  enabled              = true
  logging              = false

  source = {
    matching_target    = "ANY"
    port_matching_type = "ANY"
    zone_id            = unifi_firewall_zone.lab.id
  }

  destination = {
    matching_target    = "ANY"
    port               = "4445"
    port_matching_type = "SPECIFIC"
    zone_id            = data.unifi_firewall_zone.internal.id
  }
}

resource "unifi_firewall_policy" "nest_k8s_to_folly_k8s" {
  name                 = "Allow Nest k8s to Folly k8s"
  action               = "ALLOW"
  protocol             = "all"
  ip_version           = "BOTH"
  create_allow_respond = true
  enabled              = true
  logging              = false

  source = {
    matching_target    = "IP"
    ips                = local.nest_k8s_cidrs
    port_matching_type = "ANY"
    zone_id            = data.unifi_firewall_zone.vpn.id
  }

  destination = {
    matching_target    = "IP"
    ips                = local.folly_k8s_cidrs
    port_matching_type = "ANY"
    zone_id            = unifi_firewall_zone.lab.id
  }
}

# Rowbutt's offsite sandboxes reach the Anchor network hosts through capsule. The route is OFFSITE-OUT
# in bgp-folly.conf; this is the only Vpn -> Anchor network opening, so keep it to one port.
resource "unifi_firewall_policy" "nest_k8s_to_capsule_ssh" {
  name                 = "Allow Nest k8s to Capsule SSH"
  action               = "ALLOW"
  protocol             = "tcp"
  ip_version           = "BOTH"
  create_allow_respond = true
  enabled              = true
  logging              = false

  source = {
    matching_target    = "IP"
    ips                = local.nest_k8s_cidrs
    port_matching_type = "ANY"
    zone_id            = data.unifi_firewall_zone.vpn.id
  }

  destination = {
    matching_target    = "IP"
    ips                = ["${local.anchor.hosts.capsule}/32"]
    port               = "22"
    port_matching_type = "SPECIFIC"
    zone_id            = unifi_firewall_zone.lab.id
  }
}

resource "unifi_firewall_policy" "folly_k8s_to_nest_k8s" {
  name                 = "Allow Folly k8s to Nest k8s"
  action               = "ALLOW"
  protocol             = "all"
  ip_version           = "BOTH"
  create_allow_respond = true
  enabled              = true
  logging              = false

  source = {
    matching_target    = "IP"
    ips                = local.folly_k8s_cidrs
    port_matching_type = "ANY"
    zone_id            = unifi_firewall_zone.lab.id
  }

  destination = {
    matching_target    = "IP"
    ips                = local.nest_k8s_cidrs
    port_matching_type = "ANY"
    zone_id            = data.unifi_firewall_zone.vpn.id
  }
}

resource "unifi_firewall_policy" "lab_clients_to_nest_k8s" {
  name                 = "Allow Lab clients to Nest k8s"
  action               = "ALLOW"
  protocol             = "all"
  ip_version           = "BOTH"
  create_allow_respond = true
  enabled              = true
  logging              = false

  source = {
    matching_target    = "IP"
    ips                = [local.anchor.cidr]
    port_matching_type = "ANY"
    zone_id            = unifi_firewall_zone.lab.id
  }

  destination = {
    matching_target    = "IP"
    ips                = local.nest_k8s_cidrs
    port_matching_type = "ANY"
    zone_id            = data.unifi_firewall_zone.vpn.id
  }
}

resource "unifi_firewall_policy" "internal_to_nest_k8s" {
  name                 = "Allow Internal to Nest k8s"
  action               = "ALLOW"
  protocol             = "all"
  ip_version           = "BOTH"
  create_allow_respond = true
  enabled              = true
  logging              = false

  source = {
    matching_target    = "ANY"
    port_matching_type = "ANY"
    zone_id            = data.unifi_firewall_zone.internal.id
  }

  destination = {
    matching_target    = "NETWORK"
    network_ids        = [data.unifi_network.nest.id]
    port_matching_type = "ANY"
    zone_id            = data.unifi_firewall_zone.vpn.id
  }
}

resource "unifi_firewall_policy" "teleport_cidr_to_lab" {
  name                 = "Allow Teleport CIDR to Lab"
  action               = "ALLOW"
  protocol             = "all"
  ip_version           = "BOTH"
  create_allow_respond = true
  enabled              = true
  logging              = false

  source = {
    ip_group_id        = unifi_firewall_group.teleport_cidr.id
    matching_target    = "IP"
    port_matching_type = "ANY"
    zone_id            = data.unifi_firewall_zone.vpn.id
  }

  destination = {
    matching_target    = "ANY"
    port_matching_type = "ANY"
    zone_id            = unifi_firewall_zone.lab.id
  }
}

# Replies from folly LB VIPs to the offsite LAN are Lab-zone traffic, dropped on Lab -> Vpn
# without this. Only the LB range, so folly pods and nodes cannot initiate into that LAN.
resource "unifi_firewall_policy" "folly_lb_to_nest_lan" {
  name                 = "Allow Folly LB VIPs to Nest LAN"
  action               = "ALLOW"
  protocol             = "all"
  ip_version           = "BOTH"
  create_allow_respond = true
  enabled              = true
  logging              = false

  source = {
    matching_target    = "IP"
    ips                = [local.lb_range]
    port_matching_type = "ANY"
    zone_id            = unifi_firewall_zone.lab.id
  }

  destination = {
    matching_target    = "NETWORK"
    network_ids        = [data.unifi_network.nest.id]
    port_matching_type = "ANY"
    zone_id            = data.unifi_firewall_zone.vpn.id
  }
}

# Lab -> Internal has no general allow. REGISTER replies come from the LB VIP and INVITEs
# are SNAT'd to a node, so the source is folly_k8s_cidrs; ANY ports cover SIP and RTP.
resource "unifi_firewall_policy" "folly_pbx_to_handset" {
  name                 = "Allow Folly PBX to Office Handset"
  action               = "ALLOW"
  protocol             = "all"
  ip_version           = "BOTH"
  create_allow_respond = true
  enabled              = true
  logging              = false

  source = {
    matching_target    = "IP"
    ips                = local.folly_k8s_cidrs
    port_matching_type = "ANY"
    zone_id            = unifi_firewall_zone.lab.id
  }

  destination = {
    matching_target    = "IP"
    ips                = ["${cidrhost(local.fml_cidr, local.clients.voip.cathy.ip)}/32"]
    port_matching_type = "ANY"
    zone_id            = data.unifi_firewall_zone.internal.id
  }
}

# The bootstrap VLAN reaches the anchors on its own subnet, which the switch carries and
# the gateway never filters, the gateway's DHCP, the enrollment server's VIP, and
# the internet, where a Talos install pulls its installer image. Nothing else on
# the LAN or in the cluster's VIP range. The controller appends each policy to its
# zone pair, so each block depends on its allow to be created after it.
locals {
  enroll_ips = ["${local.topology.ENROLL_VIP}/32"]
}

resource "unifi_firewall_policy" "bootstrap_dhcp" {
  name                 = "Allow Bootstrap DHCP"
  action               = "ALLOW"
  protocol             = "udp"
  ip_version           = "IPV4"
  create_allow_respond = false
  enabled              = true
  logging              = false

  source = {
    matching_target    = "ANY"
    port_matching_type = "ANY"
    zone_id            = unifi_firewall_zone.bootstrap.id
  }

  destination = {
    matching_target    = "ANY"
    port               = "67"
    port_matching_type = "SPECIFIC"
    zone_id            = data.unifi_firewall_zone.gateway.id
  }
}

resource "unifi_firewall_policy" "bootstrap_block_gateway" {
  name                 = "Block Bootstrap to Gateway"
  action               = "BLOCK"
  protocol             = "all"
  ip_version           = "BOTH"
  create_allow_respond = false
  enabled              = true
  logging              = false

  source = {
    matching_target    = "ANY"
    port_matching_type = "ANY"
    zone_id            = unifi_firewall_zone.bootstrap.id
  }

  destination = {
    matching_target    = "ANY"
    port_matching_type = "ANY"
    zone_id            = data.unifi_firewall_zone.gateway.id
  }

  depends_on = [unifi_firewall_policy.bootstrap_dhcp]
}

# VIPs are in no zone, so the enrollment server's address is an External
# destination. The controller refuses an auto-reply rule towards External, so
# the reply is the explicit RESPOND_ONLY policy below.
resource "unifi_firewall_policy" "bootstrap_to_enroll" {
  name                 = "Allow Bootstrap to Enrollment"
  action               = "ALLOW"
  protocol             = "tcp"
  ip_version           = "IPV4"
  create_allow_respond = false
  enabled              = true
  logging              = false

  source = {
    matching_target    = "ANY"
    port_matching_type = "ANY"
    zone_id            = unifi_firewall_zone.bootstrap.id
  }

  destination = {
    matching_target    = "IP"
    ips                = local.enroll_ips
    port               = "443"
    port_matching_type = "SPECIFIC"
    zone_id            = data.unifi_firewall_zone.external.id
  }
}

# Every other cluster VIP. The rest of External, the internet, stays open by the
# zone's default.
resource "unifi_firewall_policy" "bootstrap_block_lb" {
  name                 = "Block Bootstrap to Cluster VIPs"
  action               = "BLOCK"
  protocol             = "all"
  ip_version           = "IPV4"
  create_allow_respond = false
  enabled              = true
  logging              = false

  source = {
    matching_target    = "ANY"
    port_matching_type = "ANY"
    zone_id            = unifi_firewall_zone.bootstrap.id
  }

  destination = {
    matching_target    = "IP"
    ips                = [local.lb_range]
    port_matching_type = "ANY"
    zone_id            = data.unifi_firewall_zone.external.id
  }

  depends_on = [unifi_firewall_policy.bootstrap_to_enroll]
}

# The node behind the VIP answers from the Kubernetes VLAN, so the reply is
# Lab-zone traffic, which Lab -> Bootstrap blocks by default.
resource "unifi_firewall_policy" "enroll_reply_to_bootstrap" {
  name                  = "Allow Enrollment replies to Bootstrap"
  action                = "ALLOW"
  protocol              = "tcp"
  ip_version            = "IPV4"
  connection_state_type = "RESPOND_ONLY"
  create_allow_respond  = false
  enabled               = true
  logging               = false

  source = {
    matching_target    = "IP"
    ips                = local.enroll_ips
    port               = "443"
    port_matching_type = "SPECIFIC"
    zone_id            = unifi_firewall_zone.lab.id
  }

  destination = {
    matching_target    = "ANY"
    port_matching_type = "ANY"
    zone_id            = unifi_firewall_zone.bootstrap.id
  }
}

# Intel AMT shares a node's NIC and MAC, so it follows the node onto the bootstrap
# VLAN during a reinstall. The owner's MeshCommander on the future network keeps
# the node's console and power there; nothing else reaches Bootstrap.
resource "unifi_firewall_policy" "future_to_bootstrap_amt" {
  name                 = "Allow future to Bootstrap AMT"
  action               = "ALLOW"
  protocol             = "tcp"
  ip_version           = "IPV4"
  create_allow_respond = true
  enabled              = true
  logging              = false

  source = {
    matching_target    = "NETWORK"
    network_ids        = [unifi_network.future.id]
    port_matching_type = "ANY"
    zone_id            = data.unifi_firewall_zone.internal.id
  }

  destination = {
    matching_target    = "ANY"
    port               = "16992-16995"
    port_matching_type = "SPECIFIC"
    zone_id            = unifi_firewall_zone.bootstrap.id
  }
}
