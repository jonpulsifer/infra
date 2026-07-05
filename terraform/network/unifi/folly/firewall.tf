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

# Cross-site (Site Magic) k8s reachability CIDRs.
#
# The Site Magic firewall must allow the *full* Kubernetes address space across
# the tunnel, not just the node subnets. The cross-site allow policies below
# originally matched on the k8s/nest NETWORKs (node subnets 10.3.0.0/26 and
# 10.89.0.0/28 only), so node<->node traffic worked but pod-sourced packets
# (10.100.0.0/20) were dropped at the gateway on the Lab->Vpn forward — pods
# could not reach the offsite nodes/VIPs and vice-versa. Match these CIDR lists
# inline (matching_target = "IP") so the pod CIDRs and Cilium LB VIP pools are
# permitted too.
locals {
  folly_k8s_cidrs = [
    "10.3.0.0/26",   # nodes (Kubernetes network, VLAN 8)
    "10.3.0.64/26",  # Cilium LB VIP pool
    "10.100.0.0/20", # pod CIDR
  ]
  nest_k8s_cidrs = [
    "10.89.0.0/28",  # offsite nodes
    "10.89.0.64/26", # offsite Cilium LB VIP pool
    "10.101.0.0/20", # offsite pod CIDR
  ]
}

resource "unifi_firewall_policy" "allow_established_related_internal" {
  name                 = "Allow Established/Related Internal"
  action               = "ALLOW"
  protocol             = "all"
  ip_version           = "IPV4"
  index                = 10000
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
  index                = 10000
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
  index                = 10000
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
  index                = 10000
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
  index                = 10001
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
  index                = 10001
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
  index                = 10001
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
  index                = 10001
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
  index                = 10000
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
  index                = 10000
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
  index                = 10000
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

resource "unifi_firewall_policy" "nest_k8s_to_folly_k8s" {
  name                 = "Allow Nest k8s to Folly k8s"
  action               = "ALLOW"
  protocol             = "all"
  ip_version           = "BOTH"
  index                = 10000
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
  index                = 10000
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

resource "unifi_firewall_policy" "internal_to_nest_k8s" {
  name                 = "Allow Internal to Nest k8s"
  action               = "ALLOW"
  protocol             = "all"
  ip_version           = "BOTH"
  index                = 10002
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
  index                = 10001
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
