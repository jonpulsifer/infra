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

# Atlantis on offsite reaches NetBox's API on capsule's nginx. Same sources and zones as the ssh policy.
resource "unifi_firewall_policy" "nest_k8s_to_capsule_netbox" {
  name                 = "Allow Nest k8s to Capsule NetBox"
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
    port               = "8080"
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

# The gateway relays the Kubernetes network's DHCP to Kea on spore (k8s.tf),
# and Kea answers the relay at the network's router address, on the bootstrap
# VLAN. That answer is Bootstrap-to-Gateway traffic, and the gateway's input
# chain for the pair has no rule for established flows ahead of the block
# below, so without this policy every offer dies at the gateway and no machine
# on a node port gets an address.
resource "unifi_firewall_policy" "bootstrap_dhcp_reply" {
  name                 = "Allow Boot DHCP Replies to Gateway"
  action               = "ALLOW"
  protocol             = "udp"
  ip_version           = "IPV4"
  create_allow_respond = false
  enabled              = true
  logging              = false

  source = {
    matching_target    = "IP"
    ips                = ["${local.boot_server}/32"]
    port_matching_type = "ANY"
    zone_id            = unifi_firewall_zone.bootstrap.id
  }

  destination = {
    matching_target    = "IP"
    ips                = ["${local.topology.ROUTER_IP}/32"]
    port               = "67"
    port_matching_type = "SPECIFIC"
    zone_id            = data.unifi_firewall_zone.gateway.id
  }
}

# The bootstrap network holds only spore's boot address.
# From there it reaches the anchors on its own subnet, which the switch carries
# and the gateway never filters, and the internet; nothing else on the LAN or
# in the cluster's VIP range.
#
# The controller appends a new policy at the end of its zone pair and the
# provider cannot reorder, so this block is recreated whenever the DHCP reply
# policy above changes, which lands it behind that policy.
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

  depends_on = [unifi_firewall_policy.bootstrap_dhcp_reply]

  lifecycle {
    replace_triggered_by = [unifi_firewall_policy.bootstrap_dhcp_reply]
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
}

# A node netboots and runs its Tinkerbell Workflows on the Kubernetes network,
# so Lab reaches spore's boot services on its bootstrap address. TCP: 80 for
# nginx's UKI and HookOS, 443 for fleetd's enroll.lolwtf.ca and 42113 for the
# Tink server that HookOS's agent polls. UDP: 69 for the signed iPXE over
# TFTP, 123 for chrony, and 514 for HookOS's syslog, which rsyslog on spore
# receives. Smee is off (nix/services/tinkerbell.nix), so its script port
# 7080 is not here; add it back with Smee. A machine's first DHCP needs no
# rule: the gateway relays the broadcast onto the bootstrap VLAN itself
# (k8s.tf). 67 is for a lease's renewal, which a client such as a node's AMT
# sends unicast to Kea at half the lease; without it the client waits for its
# broadcast rebind through the relay. Lab and Bootstrap are custom zones, so
# the controller creates each reply rule. A reply rule matches only these
# ports, so dnsmasq sends TFTP data from port 69 too (tftp-single-port in
# nix/services/talos-boot.nix).
resource "unifi_firewall_policy" "kubernetes_to_boot" {
  for_each = {
    tcp = "80,443,42113"
    udp = "67,69,123,514"
  }

  name                 = "Allow Kubernetes to Boot ${upper(each.key)}"
  action               = "ALLOW"
  protocol             = each.key
  ip_version           = "IPV4"
  create_allow_respond = true
  enabled              = true
  logging              = false

  source = {
    matching_target    = "NETWORK"
    network_ids        = [unifi_network.k8s.id]
    port_matching_type = "ANY"
    zone_id            = unifi_firewall_zone.lab.id
  }

  destination = {
    matching_target    = "IP"
    ips                = ["${local.boot_server}/32"]
    port               = each.value
    port_matching_type = "SPECIFIC"
    zone_id            = unifi_firewall_zone.bootstrap.id
  }
}
