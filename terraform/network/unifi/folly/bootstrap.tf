locals {
  bootstrap_cidr = "${cidrhost(local.lab_topology.BOOTSTRAP_CIDR, 1)}/${split("/", local.lab_topology.BOOTSTRAP_CIDR)[1]}"
  spore_boot_ip  = local.lab_topology.SPORE_BOOTSTRAP_IP

  # The switch ports that run MAC auth, and each node's enrolled state: the
  # network its RADIUS user puts it on. A reinstall flips a node to bootstrap,
  # and the install reboot's link flap moves it.
  mab_ports = {
    shale    = 6
    riptide  = 8
    optiplex = 10
  }
  enrolled = {
    shale    = "bootstrap"
    riptide  = "kubernetes"
    optiplex = "kubernetes"
  }
  mab_networks = {
    kubernetes = unifi_network.k8s
    bootstrap  = unifi_network.bootstrap
  }

  # The nodes whose switch port runs MAC auth. Any name turns switch-wide
  # 802.1X on. Add a node only after the gateway's RADIUS server listens:
  # `ss -lunp | grep :1812` over SSH names a freeradius process (it is no
  # systemd unit there), and the Default RADIUS profile has RADIUS assigned
  # VLAN on for wired. Otherwise the node loses the network at its next link
  # flap. riptide goes first; optiplex is the control plane. An empty set keeps
  # every port on its open Kubernetes trunk, and is also the revert.
  mab_enforced = toset(["riptide", "shale"])

  switch = local.clients.switches["USW 24 PoE"]
}

resource "unifi_network" "bootstrap" {
  name                = "bootstrap"
  subnet              = local.bootstrap_cidr
  vlan                = tonumber(local.lab_topology.BOOTSTRAP_VLAN)
  domain_name         = local.lab_domain
  setting_preference  = "manual"
  auto_scale          = false
  lte_lan             = false
  network_isolation   = true
  multicast_dns       = false
  ipv6_interface_type = "none"

  # Smee on spore names the boot file in a proxy offer, which EDK2 prefers. A
  # file here would boot the MACs that Smee ignores, which must not boot.
  dhcp_server = {
    enabled     = true
    leasetime   = "1h0m0s"
    start       = cidrhost(local.bootstrap_cidr, 2)
    stop        = cidrhost(local.bootstrap_cidr, 10)
    dns_enabled = true
    dns_servers = [local.spore_boot_ip]
    boot = {
      enabled = false
    }
  }

  lifecycle {
    precondition {
      condition = contains(
        [for i in range(11, pow(2, 32 - tonumber(split("/", local.bootstrap_cidr)[1])) - 1) : cidrhost(local.bootstrap_cidr, i)],
        local.spore_boot_ip,
      )
      error_message = "lab-topology.json's SPORE_BOOTSTRAP_IP must be in BOOTSTRAP_CIDR above the DHCP pool, which ends at host 10."
    }
  }
}

# The controller's Default profile is the one the switch-wide setting points at.
# The API refuses to modify it (CannotModifyDefaultRadiusProfile), so its
# "RADIUS assigned VLAN" for wired networks is turned on once in the UI
# (Settings > Profiles > RADIUS > Default). The removed block drops the
# earlier import from state without touching the controller.
removed {
  from = unifi_radius_profile.default

  lifecycle {
    destroy = false
  }
}

resource "unifi_setting" "global_switch" {
  global_switch = {
    dot1x_portctrl_enabled = length(local.mab_enforced) > 0
  }
}

# The switch-wide 802.1X fallback network is bootstrap, set in the console: the
# provider has no field for it. A MAC that RADIUS rejects, or that gets no
# answer, lands there. RADIUS answers every known user with a VLAN, so the
# native network applies only on a mistake, and it fails into bootstrap too.
resource "unifi_port_profile" "mab" {
  name                  = "MAC auth"
  native_networkconf_id = unifi_network.bootstrap.id
  forward               = "native"
  tagged_vlan_mgmt      = "block_all"
  dot1x_ctrl            = "mac_based"
  dot1x_idle_timeout    = "5m"
}

# UniFi MAC auth wants the MAC, upper case with no separators, as both name and
# password. vlan is set beside network_id because the provider derives it only
# at create.
resource "unifi_radius_user" "node" {
  for_each = local.mab_ports

  name               = upper(replace(local.clients.k8s[each.key].mac, ":", ""))
  password           = upper(replace(local.clients.k8s[each.key].mac, ":", ""))
  tunnel_type        = 13
  tunnel_medium_type = 6
  tunnel_config_type = "802.1x"
  network_id         = local.mab_networks[local.enrolled[each.key]].id
  vlan               = local.mab_networks[local.enrolled[each.key]].vlan
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

  # spore keeps Lab Net untagged and its PoE, and gains the bootstrap VLAN
  # tagged for its proxy DHCP, TFTP and HTTP. The provider cannot write
  # tagged_networkconf_ids, so the custom list names what to leave off.
  port_override {
    index                 = 7
    name                  = "spore"
    poe_mode              = "auto"
    dot1x_ctrl            = "force_authorized"
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

  dynamic "port_override" {
    for_each = { for node, port in local.mab_ports : node => port if contains(local.mab_enforced, node) }
    content {
      index           = port_override.value
      name            = port_override.key
      port_profile_id = unifi_port_profile.mab.id
    }
  }

  dynamic "port_override" {
    for_each = { for node, port in local.mab_ports : node => port if !contains(local.mab_enforced, node) }
    content {
      index                 = port_override.value
      name                  = port_override.key
      forward               = "customize"
      native_networkconf_id = unifi_network.k8s.id
      tagged_vlan_mgmt      = "auto"
      dot1x_ctrl            = "force_authorized"
    }
  }

  # A port turns MAC auth on only after its user, the profile's VLAN assignment
  # and the switch-wide 802.1X setting exist.
  depends_on = [
    unifi_radius_user.node,
    unifi_setting.global_switch,
  ]
}
