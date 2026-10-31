locals {
  oldschool_node_ports  = { retrofit = 6, oldschool = 7, hotrod = 8 }
  oldschool_panel_ports = { retrofit = 8, oldschool = 9, hotrod = 10, uplink = 12 }
}

resource "netbox_device_interface" "oldschool_node_port" {
  for_each  = local.oldschool_node_ports
  device_id = netbox_device.lab["oldschool-main-switch"].id
  name      = "Port ${each.value}"
  type      = "2.5gbase-t"
  tags      = [local.managed_tag]
}

resource "netbox_cable" "oldschool_node" {
  for_each = local.oldschool_node_ports
  status   = "connected"
  tags     = [local.managed_tag]
  a_termination {
    object_type = "dcim.interface"
    object_id   = netbox_device_interface.lab[each.key].id
  }
  b_termination {
    object_type = "dcim.rearport"
    object_id   = netbox_device_rear_port.oldschool[each.key].id
  }
}

resource "netbox_device_rear_port" "oldschool" {
  for_each    = local.oldschool_panel_ports
  device_id   = netbox_device.rack_component["oldschool-patch-panel"].id
  name        = tostring(each.value)
  type        = "other"
  positions   = 1
  description = "Rear termination type needs verification"
  tags        = [local.managed_tag]
}

resource "netbox_device_front_port" "oldschool" {
  for_each           = local.oldschool_panel_ports
  device_id          = netbox_device.rack_component["oldschool-patch-panel"].id
  name               = tostring(each.value)
  type               = "8p8c"
  rear_port_id       = netbox_device_rear_port.oldschool[each.key].id
  rear_port_position = 1
  tags               = [local.managed_tag]
}

resource "netbox_cable" "oldschool_patch_switch" {
  for_each = local.oldschool_node_ports
  status   = "connected"
  tags     = [local.managed_tag]
  a_termination {
    object_type = "dcim.frontport"
    object_id   = netbox_device_front_port.oldschool[each.key].id
  }
  b_termination {
    object_type = "dcim.interface"
    object_id   = netbox_device_interface.oldschool_node_port[each.key].id
  }
}

resource "netbox_device_interface" "oldschool_switch_uplink" {
  device_id = netbox_device.lab["oldschool-main-switch"].id
  name      = "Port 9"
  type      = "10gbase-t"
  tags      = [local.managed_tag]
}

resource "netbox_device_interface" "oldschool_gateway_lan" {
  device_id = netbox_device.lab["oldschool-gateway"].id
  name      = "Port 4"
  type      = "2.5gbase-t"
  tags      = [local.managed_tag]
}

resource "netbox_cable" "oldschool_uplink_switch" {
  status = "connected"
  tags   = [local.managed_tag]
  a_termination {
    object_type = "dcim.frontport"
    object_id   = netbox_device_front_port.oldschool["uplink"].id
  }
  b_termination {
    object_type = "dcim.interface"
    object_id   = netbox_device_interface.oldschool_switch_uplink.id
  }
}

resource "netbox_cable" "oldschool_uplink_gateway" {
  status = "connected"
  tags   = [local.managed_tag]
  a_termination {
    object_type = "dcim.rearport"
    object_id   = netbox_device_rear_port.oldschool["uplink"].id
  }
  b_termination {
    object_type = "dcim.interface"
    object_id   = netbox_device_interface.oldschool_gateway_lan.id
  }
}
