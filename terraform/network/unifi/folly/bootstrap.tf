locals {
  bootstrap_cidr = "${cidrhost(local.anchor_topology.BOOTSTRAP_CIDR, 1)}/${split("/", local.anchor_topology.BOOTSTRAP_CIDR)[1]}"

  # The anchors' bootstrap addresses, spore first, and the boot VIP that
  # keepalived moves between them (nix/services/anchor-vips.nix).
  anchor_boot_ips = [
    local.anchor_topology.SPORE_BOOTSTRAP_IP,
    local.anchor_topology.CAPSULE_BOOTSTRAP_IP,
    local.anchor_topology.FORGE_BOOTSTRAP_IP,
  ]
  boot_vip = local.anchor_topology.BOOT_VIP

  # The Kubernetes network's DHCP boot option: the signed iPXE that dnsmasq
  # serves over TFTP at the boot VIP.
  boot_option = {
    enabled  = true
    server   = local.boot_vip
    filename = "talos/folly/ipxe-amd64-secureboot.efi"
  }

  # The switch port of each anchor, read from the live switch.
  anchor_ports = {
    capsule = 5
    spore   = 7
    forge   = 9
  }

  # Every node port is a Kubernetes port: each inventory node's switch_port,
  # named for the node, and the free rack ports where a new box may be
  # cabled. A node carries its address statically, so a port needs neither
  # MAC auth nor a reservation.
  free_node_ports = [4, 12, 20, 24]
  node_ports = merge(
    { for port in local.free_node_ports : tostring(port) => "node" },
    { for node, m in local.machines : tostring(m.switch_port) => node if try(m.switch_port, null) != null },
  )

  switch = local.clients.switches["USW 24 PoE"]
}

# The anchors' bootstrap addresses and the boot VIP live here: every node
# netboots from them across the gateway (kubernetes_to_boot in firewall.tf).
# No switch port carries the network untagged, so it has no DHCP.
resource "unifi_network" "bootstrap" {
  name               = "bootstrap"
  subnet             = local.bootstrap_cidr
  vlan               = tonumber(local.anchor_topology.BOOTSTRAP_VLAN)
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
    enabled = false
  }

  lifecycle {
    precondition {
      condition = alltrue([
        for ip in concat(local.anchor_boot_ips, [local.boot_vip]) : contains(
          [for i in range(2, pow(2, 32 - tonumber(split("/", local.bootstrap_cidr)[1])) - 1) : cidrhost(local.bootstrap_cidr, i)],
          ip,
        )
      ]) && length(distinct(concat(local.anchor_boot_ips, [local.boot_vip]))) == 4
      error_message = "anchor-topology.json's SPORE_BOOTSTRAP_IP, CAPSULE_BOOTSTRAP_IP, FORGE_BOOTSTRAP_IP and BOOT_VIP must be four distinct host addresses in BOOTSTRAP_CIDR other than the gateway."
    }
  }
}

# The controller's Default RADIUS profile was imported once; the removed
# block drops it from state without touching the controller.
removed {
  from = unifi_radius_profile.default

  lifecycle {
    destroy = false
  }
}

# No port runs 802.1X or MAC auth. The setting depends on the switch, so its
# ports leave the MAC auth profile before 802.1X turns off switch-wide.
resource "unifi_setting" "global_switch" {
  global_switch = {
    dot1x_portctrl_enabled = false
  }

  depends_on = [unifi_device.usw_24_poe]
}

import {
  to = unifi_device.usw_24_poe
  id = local.switch.mac
}

# Declared ports replace their whole override; undeclared ports keep theirs.
resource "unifi_device" "usw_24_poe" {
  mac               = local.switch.mac
  name              = "USW 24 PoE"
  forget_on_destroy = false
  allow_adoption    = false

  # Each anchor keeps the Anchor network untagged and its PoE, and gains the bootstrap
  # VLAN tagged for TFTP, HTTP, DNS, NTP and the boot VIP's VRRP, and on spore
  # Smee's proxy DHCP. The provider cannot write tagged_networkconf_ids, so the
  # custom list names what to leave off.
  dynamic "port_override" {
    for_each = local.anchor_ports
    content {
      index    = port_override.value
      name     = port_override.key
      poe_mode = "auto"
      dot1x = {
        ctrl = "force_authorized"
      }
      forward               = "customize"
      native_networkconf_id = unifi_network.lab.id
      tagged_vlan_mgmt      = "custom"
      excluded_networkconf_ids = [
        unifi_network.fml.id,
        unifi_network.k8s.id,
        unifi_network.future.id,
        unifi_network.iot.id,
      ]
    }
  }

  # A node port carries the Kubernetes network untagged and nothing else.
  dynamic "port_override" {
    for_each = local.node_ports
    content {
      index                 = tonumber(port_override.key)
      name                  = port_override.value
      forward               = "customize"
      native_networkconf_id = unifi_network.k8s.id
      tagged_vlan_mgmt      = "block_all"
      dot1x = {
        ctrl = "force_authorized"
      }
    }
  }

  lifecycle {
    precondition {
      condition     = length(setintersection(keys(local.node_ports), [for p in values(local.anchor_ports) : tostring(p)])) == 0
      error_message = "A node's switch_port in clusters/folly/inventory/machines.yaml, or a free node port, is an anchor's port."
    }
  }
}
