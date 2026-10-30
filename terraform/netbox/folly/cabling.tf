locals {
  oldschool_node_ports = { retrofit = 6, oldschool = 7, hotrod = 8 }
}

resource "netbox_device_interface" "oldschool_node_port" {
  for_each  = local.oldschool_node_ports
  device_id = netbox_device.lab["oldschool-main-switch"].id
  name      = "Port ${each.value}"
  type      = "other"
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
    object_type = "dcim.interface"
    object_id   = netbox_device_interface.oldschool_node_port[each.key].id
  }
}
