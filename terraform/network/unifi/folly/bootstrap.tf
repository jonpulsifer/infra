locals {
  bootstrap_cidr = "${cidrhost(local.anchor_topology.BOOTSTRAP_CIDR, 1)}/${split("/", local.anchor_topology.BOOTSTRAP_CIDR)[1]}"

  # spore's bootstrap address, where it serves TFTP, the boot files, Kea,
  # Tink and fleetd (nix/services/talos-boot.nix, nix/services/kea.nix,
  # nix/services/fleetd.nix). The Kubernetes network relays its DHCP here.
  boot_server = local.anchor_topology.SPORE_BOOTSTRAP_IP

  # The boot option the gateway's own DHCP named while it leased the
  # Kubernetes network: the signed iPXE that dnsmasq serves over TFTP on
  # spore. Kea makes the same offer now; k8s.tf keeps this disabled in place
  # for the rollback.
  boot_option = {
    enabled  = true
    server   = local.boot_server
    filename = "talos/folly/ipxe-amd64-secureboot.efi"
  }

  # The switch port of each anchor, read from the live switch.
  anchor_ports = {
    capsule = 5
    spore   = 7
    forge   = 9
  }

  # Every node port is a Kubernetes port: each declared node's switch_port,
  # named for the node, and the free rack ports where a new box may be
  # cabled. A node carries its address statically, so a port needs neither
  # MAC auth nor a reservation.
  free_node_ports = [4, 12, 20, 24]
  node_ports = merge(
    { for port in local.free_node_ports : tostring(port) => "node" },
    { for node, m in local.nodes : tostring(m.switch_port) => node },
  )

  # The uplink to the gateway, read from the live switch, and the sensor port:
  # the USB NIC of the Zeek and Suricata sensor on shale
  # (clusters/folly/apps/sensor/). The switch copies every frame of the
  # uplink, both directions, onto the sensor port, which forwards nothing.
  uplink_port = 25
  sensor_port = 23

  switch = local.clients.switches["USW 24 PoE"]
}

# spore's bootstrap address lives here: every node netboots from it across
# the gateway (kubernetes_to_boot in firewall.tf). No switch port carries the
# network untagged, so it has no DHCP.
resource "unifi_network" "bootstrap" {
  name               = local.network_catalog.bootstrap.name
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

  # No gateway DHCP here: spore's boot address is static, and the relay's replies from Kea need
  # the firewall policy in firewall.tf, not a server on this VLAN.
  dhcp_server = {
    enabled = false
  }

  lifecycle {
    precondition {
      condition = contains(
        [for i in range(2, pow(2, 32 - tonumber(split("/", local.bootstrap_cidr)[1])) - 1) : cidrhost(local.bootstrap_cidr, i)],
        local.boot_server,
      )
      error_message = "anchor-topology.json's SPORE_BOOTSTRAP_IP must be a host address in BOOTSTRAP_CIDR other than the gateway."
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

  # Only spore carries tagged bootstrap traffic. UniFi stores a port with
  # every tagged VLAN blocked as native/block_all, without an exclusion list.
  dynamic "port_override" {
    for_each = local.anchor_ports
    content {
      index    = port_override.value
      name     = port_override.key
      poe_mode = "auto"
      dot1x = {
        ctrl = "force_authorized"
      }
      forward               = port_override.key == "spore" ? "customize" : "native"
      native_networkconf_id = unifi_network.lab.id
      tagged_vlan_mgmt      = port_override.key == "spore" ? "custom" : "block_all"
      excluded_networkconf_ids = port_override.key == "spore" ? [
        unifi_network.fml.id,
        unifi_network.k8s.id,
        unifi_network.future.id,
        unifi_network.iot.id,
      ] : []
    }
  }

  # A node port carries the Kubernetes network untagged and nothing else. The
  # controller stores a native network with every tagged VLAN blocked as
  # forward native.
  dynamic "port_override" {
    for_each = local.node_ports
    content {
      index                 = tonumber(port_override.key)
      name                  = port_override.value
      forward               = "native"
      native_networkconf_id = unifi_network.k8s.id
      tagged_vlan_mgmt      = "block_all"
      dot1x = {
        ctrl = "force_authorized"
      }
    }
  }

  # The sensor port mirrors the uplink. The controller stores a mirror port
  # as forward native, and the mirror mode is what stops it forwarding. Only
  # these attributes: the provider leaves the rest of a new block unknown
  # after apply, which fails the apply.
  port_override {
    index            = local.sensor_port
    name             = "sensor"
    op_mode          = "mirror"
    mirror_port_idx  = local.uplink_port
    forward          = "native"
    isolation        = true
    tagged_vlan_mgmt = "block_all"
  }

  lifecycle {
    precondition {
      condition     = length(setintersection(keys(local.node_ports), [for p in values(local.anchor_ports) : tostring(p)])) == 0
      error_message = "A node's switch_port in clusters/folly/inventory/nodes.yaml, or a free node port, is an anchor's port."
    }
    precondition {
      condition     = !contains(concat(keys(local.node_ports), [for p in values(local.anchor_ports) : tostring(p)]), tostring(local.sensor_port)) && local.sensor_port != local.uplink_port
      error_message = "The sensor port is a node's, an anchor's or the uplink's port."
    }
  }
}
