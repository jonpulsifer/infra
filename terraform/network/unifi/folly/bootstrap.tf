locals {
  bootstrap_cidr = "${cidrhost(local.anchor_topology.BOOTSTRAP_CIDR, 1)}/${split("/", local.anchor_topology.BOOTSTRAP_CIDR)[1]}"

  # spore's bootstrap address, where it serves TFTP, the boot files, Kea,
  # Tink and fleetd (nix/services/talos-boot.nix, nix/services/kea.nix,
  # nix/services/fleetd.nix). The Kubernetes network relays its DHCP here.
  boot_server = local.anchor_topology.SPORE_BOOTSTRAP_IP
  # The host index of the boot address in its network, which bounds the bootstrap pool below it.
  boot_server_index = index(
    [for i in range(0, pow(2, 32 - tonumber(split("/", local.bootstrap_cidr)[1]))) : cidrhost(local.bootstrap_cidr, i)],
    local.boot_server,
  )

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

  # The gateway's DHCP is dnsmasq, which also runs the Kubernetes network's relay (k8s.tf), and
  # dnsmasq honours a packet only on an interface it serves. Kea's replies to the relay arrive on
  # this network's interface, so the gateway serves DHCP here too, or it drops every reply and no
  # machine on a node port gets its offer. Nothing on this VLAN asks for a lease: spore's boot
  # address is static, and the pool stops short of it.
  dhcp_server = {
    enabled   = true
    leasetime = local.one_day
    start     = cidrhost(local.bootstrap_cidr, 2)
    stop      = cidrhost(local.bootstrap_cidr, local.boot_server_index - 1)
  }

  lifecycle {
    precondition {
      condition = contains(
        [for i in range(2, pow(2, 32 - tonumber(split("/", local.bootstrap_cidr)[1])) - 1) : cidrhost(local.bootstrap_cidr, i)],
        local.boot_server,
      )
      error_message = "anchor-topology.json's SPORE_BOOTSTRAP_IP must be a host address in BOOTSTRAP_CIDR other than the gateway."
    }
    precondition {
      condition     = local.boot_server_index >= 3
      error_message = "anchor-topology.json's SPORE_BOOTSTRAP_IP must leave at least one host address between the gateway and itself for the bootstrap network's DHCP pool."
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

  lifecycle {
    precondition {
      condition     = length(setintersection(keys(local.node_ports), [for p in values(local.anchor_ports) : tostring(p)])) == 0
      error_message = "A node's switch_port in clusters/folly/inventory/nodes.yaml, or a free node port, is an anchor's port."
    }
  }
}
