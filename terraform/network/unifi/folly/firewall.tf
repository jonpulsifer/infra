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
# Read the SOURCE and DESTINATION halves of the cross-site policies differently,
# because the gateway picks a forward chain from each half differently.
#
# SOURCE is load-bearing for every CIDR listed. Zone entry is by ingress
# interface, so a pod-sourced or VIP-sourced packet leaving br8 is in the Lab
# zone regardless of its address, and the Lab->Vpn chain closes with a DROP.
# Omit 10.100.0.0/20 here and pod-sourced traffic to an offsite node is dropped.
#
# DESTINATION only dispatches for the node CIDR. A UniFi zone holds the subnets
# of *declared* networks and nothing else, and the Cilium LB pool and pod CIDR
# are BGP-learned, so they are in no zone: a packet addressed to one misses the
# zone match and takes the source zone's -> WAN fall-through, which accepts. The
# other destination entries are therefore declared intent the zone dispatch
# never consults. Keep them — they document the boundary, they cost nothing in a
# hash:net ipset, and they become live the day the prefixes are ever zoned.
#
# The one cross-site policy whose destination genuinely dispatches is
# folly_lb_to_nest_lan below: the offsite subnets are declared networks on the
# far console, so Site Magic carries them into the Vpn zone.
locals {
  # Cross-site k8s CIDRs derived from the network SSOT (topology.tf).
  # folly_k8s_cidrs covers the folly cluster's node subnet, Cilium LB VIP pool,
  # and pod CIDR.  nest_k8s_cidrs covers the offsite cluster's equivalent.
  folly_k8s_cidrs = [
    local.topology.K8S_NODE_CIDR,   # nodes (Kubernetes network, VLAN 8)
    local.lb_range,                 # Cilium LB VIP pool
    local.topology.CILIUM_POD_CIDR, # pod CIDR
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

# The offsite client LAN reaches folly's Cilium LB VIPs.
#
# Clients on the offsite Default network (nest.pulsifer.ca) resolve folly-hosted
# hostnames to addresses in folly's LB pool and route to them over Site Magic.
# The reply is sourced from the VIP, which sits in the Lab zone, so without this
# the SYN is accepted but the SYN-ACK is dropped on the Lab->Vpn forward and the
# connection blackholes. Scoped to the LB range rather than local.folly_k8s_cidrs
# so folly pods and nodes still cannot initiate into the offsite LAN.
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
