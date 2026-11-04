locals {
  rack_inventory  = jsondecode(file("${path.module}/rack-components.json"))
  rack_components = local.rack_inventory.components
  shelved_nodes = {
    optiplex = { rack = "folly", shelf = "U6, right-hand side" }
    riptide  = { rack = "folly", shelf = "U5, left-hand side" }
    shale    = { rack = "folly", shelf = "U5, right-hand side" }
  }
  mounted_devices = {
    folly_gateway = { rack = "folly", unit = 12 }
    folly_switch  = { rack = "folly", unit = 10 }
  }
  mounted_device_types = {
    folly_gateway = data.netbox_device_type.lab["UDMPRO"].id
    folly_switch  = data.netbox_device_type.mounted_switch.id
  }
  mounted_device_ids = {
    folly_gateway = netbox_device.lab["folly-fml.pulsifer.ca-a5e7"].id
    folly_switch  = data.netbox_devices.switch.devices[0].device_id
  }
  rack_occupied_units = { for rack in keys(local.racks) : rack => concat(
    flatten([for c in values(local.rack_components) : range(c.unit, c.unit + local.rack_inventory.models[c.model].height) if c.rack == rack]),
    [for d in values(local.mounted_devices) : d.unit if d.rack == rack],
  ) }
}

data "netbox_device_type" "mounted_switch" {
  slug = "ubiquiti-usw-24-poe"
}

resource "restapi_object" "mounted_type" {
  for_each = {
    gateway = data.netbox_device_type.lab["UDMPRO"].id
    switch  = data.netbox_device_type.mounted_switch.id
  }
  path                    = "/dcim/device-types"
  object_id               = tostring(each.value)
  create_method           = "PATCH"
  create_path             = "/dcim/device-types/{id}/"
  read_path               = "/dcim/device-types/{id}/"
  update_path             = "/dcim/device-types/{id}/"
  destroy_method          = "PATCH"
  destroy_path            = "/dcim/device-types/{id}/"
  destroy_data            = jsonencode({})
  ignore_server_additions = true
  data                    = jsonencode({ u_height = 1 })
  depends_on              = [netbox_permission.terraform_manage, netbox_permission.terraform_read]
}

resource "netbox_device_role" "rack_component" {
  name       = "rack-component"
  slug       = "rack-component"
  color_hex  = "607d8b"
  depends_on = [netbox_permission.terraform_manage, netbox_permission.terraform_read]
}

resource "netbox_device_type" "rack_component" {
  for_each        = local.rack_inventory.models
  model           = each.value.model
  slug            = "lab-rack-${each.key}"
  manufacturer_id = local.lab_manufacturers[each.value.manufacturer]
  u_height        = each.value.height
  is_full_depth   = false
  tags            = [local.managed_tag]
  depends_on      = [netbox_permission.terraform_manage, netbox_permission.terraform_read]
}

resource "netbox_device" "rack_component" {
  for_each       = local.rack_components
  name           = each.key
  site_id        = local.lab_sites[each.value.rack]
  rack_id        = netbox_rack.lab[each.value.rack].id
  rack_position  = each.value.unit
  rack_face      = "front"
  device_type_id = netbox_device_type.rack_component[each.value.model].id
  role_id        = netbox_device_role.rack_component.id
  description    = each.value.description
  status         = "active"
  tags           = [local.managed_tag]
  lifecycle {
    ignore_changes = [status, custom_fields]
    precondition {
      condition     = each.value.unit >= 1 && each.value.unit + local.rack_inventory.models[each.value.model].height - 1 <= local.racks[each.value.rack].height
      error_message = "Every rack component must fit within its rack's unit range."
    }
    precondition {
      condition     = length(distinct(local.rack_occupied_units[each.value.rack])) == length(local.rack_occupied_units[each.value.rack])
      error_message = "Rack components and mounted devices must not overlap."
    }
  }
}

# Placement writes only the rack fields; device lifecycle and attestation stay intact.
resource "restapi_object" "mounted_device" {
  for_each                = local.mounted_devices
  path                    = "/dcim/devices"
  object_id               = tostring(local.mounted_device_ids[each.key])
  create_method           = "PATCH"
  create_path             = "/dcim/devices/{id}/"
  read_path               = "/dcim/devices/{id}/"
  update_path             = "/dcim/devices/{id}/"
  destroy_method          = "PATCH"
  destroy_path            = "/dcim/devices/{id}/"
  destroy_data            = jsonencode({})
  ignore_server_additions = true
  data = jsonencode({
    device_type = tonumber(local.mounted_device_types[each.key])
    rack        = tonumber(netbox_rack.lab[each.value.rack].id)
    position    = each.value.unit
    face        = "front"
  })
  depends_on = [restapi_object.mounted_type, restapi_object.lab_declared, netbox_device_primary_ip.lab]
}

resource "restapi_object" "shelved_node" {
  depends_on              = [restapi_object.declared]
  for_each                = local.shelved_nodes
  path                    = "/dcim/devices"
  object_id               = tostring(netbox_device.node[each.key].id)
  create_method           = "PATCH"
  create_path             = "/dcim/devices/{id}/"
  read_path               = "/dcim/devices/{id}/"
  update_path             = "/dcim/devices/{id}/"
  destroy_method          = "PATCH"
  destroy_path            = "/dcim/devices/{id}/"
  destroy_data            = jsonencode({})
  ignore_server_additions = true
  data                    = jsonencode({ rack = tonumber(netbox_rack.lab[each.value.rack].id), description = "Shelf ${each.value.shelf}" })
}

data "netbox_device_role" "anchor" {
  name = "anchor"
}

data "netbox_devices" "anchors" {
  filter {
    name  = "site_id"
    value = data.netbox_site.folly.id
  }
  filter {
    name  = "role_id"
    value = data.netbox_device_role.anchor.id
  }
}

locals {
  anchor_ids = { for d in data.netbox_devices.anchors.devices : d.name => d.device_id }
}

resource "restapi_object" "rack_anchor" {
  for_each                = toset(["capsule", "spore", "forge"])
  path                    = "/dcim/devices"
  object_id               = tostring(local.anchor_ids[each.key])
  create_method           = "PATCH"
  create_path             = "/dcim/devices/{id}/"
  read_path               = "/dcim/devices/{id}/"
  update_path             = "/dcim/devices/{id}/"
  destroy_method          = "PATCH"
  destroy_path            = "/dcim/devices/{id}/"
  destroy_data            = jsonencode({})
  ignore_server_additions = true
  data                    = jsonencode({ rack = tonumber(netbox_rack.lab["folly"].id), description = "Anchor on top of folly's 19-inch rack" })
}
