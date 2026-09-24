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
    ips                = [local.lab.cidr]
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
