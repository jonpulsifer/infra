module "oldschool_topology" {
  source = "../../modules/cluster-topology"
  site   = "offsite"
}

locals {
  lab_inventory = jsondecode(file("${path.module}/lab-inventory.json"))
  lab_clients = {
    folly     = yamldecode(file("${path.module}/../../network/unifi/folly/clients.yaml"))
    oldschool = yamldecode(file("${path.module}/../../network/unifi/offsite/clients.yaml"))
  }
  lab_models  = local.lab_inventory.models
  lab_devices = local.lab_inventory.devices
  lab_roles = merge({
    switch            = data.netbox_device_role.switch.id
    "kubernetes-node" = data.netbox_device_role.node.id
    gateway           = data.netbox_device_role.gateway.id
  }, { for k, v in netbox_device_role.lab : k => v.id })
  lab_platforms     = merge({ "Talos Linux" = data.netbox_platform.talos.id }, { for k, v in data.netbox_platform.lab : k => v.id }, { for k, v in netbox_platform.lab : k => v.id })
  lab_model_ids     = merge({ for k, v in netbox_device_type.lab : k => v.id }, { for k, v in data.netbox_device_type.lab : k => v.id })
  lab_manufacturers = merge({ for k, v in data.netbox_manufacturers.lab : k => one(v.manufacturers).id }, { for k, v in netbox_manufacturer.lab : k => v.id })
  lab_macs = { for k, v in local.lab_devices : k => try(v.mac, local.lab_clients[v.site][v.client_group][v.client].mac)
    if contains(keys(v), "mac") || can(local.lab_clients[v.site][v.client_group][v.client].mac)
  }
  lab_addresses = { for k, v in local.lab_devices : k => {
    address = v.site == "oldschool" ? jsondecode(module.oldschool_topology.data.NODE_ADDRESSES)[k] : cidrhost(local.lab_networks[v.network].prefix, local.lab_clients[v.site][v.client_group][v.client].ip)
    prefix  = split("/", local.lab_networks[v.network].prefix)[1]
  } if contains(keys(v), "network") }
}

data "netbox_manufacturers" "lab" {
  for_each = toset(["hp", "raspberry-pi", "ubiquiti"])
  filter {
    name  = "slug"
    value = each.key
  }
}

resource "netbox_manufacturer" "lab" {
  for_each   = { asus = "ASUS", cisco = "Cisco", unknown = "Unknown", jetkvm = "JetKVM", philips-hue = "Philips Hue", cable-matters = "Cable Matters", iwillink = "iWillink", cyberpower = "CyberPower" }
  name       = each.value
  slug       = each.key
  depends_on = [netbox_permission.terraform_manage]
}

data "netbox_device_type" "lab" {
  for_each = { for k, v in local.lab_models : k => v if v.existing_slug != null }
  slug     = each.value.existing_slug
}

resource "netbox_device_type" "lab" {
  for_each        = { for k, v in local.lab_models : k => v if v.existing_slug == null }
  model           = each.value.model
  slug            = "lab-${lower(each.key)}"
  manufacturer_id = local.lab_manufacturers[each.value.manufacturer]
  u_height        = 0
  is_full_depth   = false
  tags            = [local.managed_tag]
  depends_on      = [netbox_permission.terraform_manage]
}

resource "netbox_device_role" "lab" {
  for_each   = { server = "2196f3", desktop = "9e9e9e", console = "ff9800", "access-point" = "4caf50", "home-automation" = "673ab7" }
  name       = each.key
  slug       = each.key
  color_hex  = each.value
  depends_on = [netbox_permission.terraform_manage]
}

data "netbox_device_role" "gateway" {
  name = "gateway"
}

data "netbox_platform" "lab" {
  for_each = toset(["NixOS"])
  name     = each.key
}

resource "netbox_platform" "lab" {
  for_each   = { Windows = "windows", "Raspberry Pi OS" = "raspberry-pi-os" }
  name       = each.key
  slug       = each.value
  depends_on = [netbox_permission.terraform_manage]
}

# The owner's lifecycle and custom fields survive subsequent inventory updates.
resource "netbox_device" "lab" {
  for_each       = local.lab_devices
  name           = each.key
  site_id        = local.lab_sites[each.value.site]
  role_id        = local.lab_roles[each.value.role]
  device_type_id = local.lab_model_ids[each.value.model]
  platform_id    = try(local.lab_platforms[each.value.platform], null)
  serial         = try(each.value.serial, "")
  status         = each.value.status
  description    = try(each.value.description, "")
  tags           = [local.managed_tag]
  lifecycle {
    ignore_changes = all
  }
  depends_on = [netbox_permission.terraform_manage]
}

resource "restapi_object" "lab_declared" {
  for_each                = local.lab_devices
  path                    = "/dcim/devices"
  object_id               = tostring(netbox_device.lab[each.key].id)
  create_method           = "PATCH"
  create_path             = "/dcim/devices/{id}/"
  read_path               = "/dcim/devices/{id}/"
  update_path             = "/dcim/devices/{id}/"
  destroy_method          = "PATCH"
  destroy_path            = "/dcim/devices/{id}/"
  destroy_data            = jsonencode({})
  ignore_server_additions = true
  data = jsonencode({
    name        = each.key
    site        = tonumber(local.lab_sites[each.value.site])
    role        = tonumber(local.lab_roles[each.value.role])
    device_type = tonumber(local.lab_model_ids[each.value.model])
    platform    = try(tonumber(local.lab_platforms[each.value.platform]), null)
    serial      = try(each.value.serial, "")
    description = try(each.value.description, "")
  })
}

resource "netbox_device_interface" "lab" {
  for_each  = { for k, v in local.lab_devices : k => v if contains(keys(v), "interface") }
  device_id = netbox_device.lab[each.key].id
  name      = each.value.interface
  type      = each.value.interface == "management" ? "other" : each.value.interface == "wlan0" ? "ieee802.11n" : "1000base-t"
  mgmtonly  = each.value.interface == "management"
  tags      = [local.managed_tag]
}

resource "restapi_object" "lab_rack" {
  for_each                = { for k, v in local.lab_devices : k => v if contains(keys(v), "rack") }
  path                    = "/dcim/devices"
  object_id               = tostring(netbox_device.lab[each.key].id)
  create_method           = "PATCH"
  create_path             = "/dcim/devices/{id}/"
  read_path               = "/dcim/devices/{id}/"
  update_path             = "/dcim/devices/{id}/"
  destroy_method          = "PATCH"
  destroy_path            = "/dcim/devices/{id}/"
  destroy_data            = jsonencode({})
  ignore_server_additions = true
  data                    = jsonencode({ rack = tonumber(netbox_rack.lab[each.value.rack].id) })
}

resource "netbox_mac_address" "lab" {
  for_each            = local.lab_macs
  mac_address         = each.value
  device_interface_id = netbox_device_interface.lab[each.key].id
  tags                = [local.managed_tag]
}

resource "netbox_ip_address" "lab" {
  for_each     = local.lab_addresses
  ip_address   = "${each.value.address}/${each.value.prefix}"
  status       = "active"
  object_type  = "dcim.interface"
  interface_id = netbox_device_interface.lab[each.key].id
  tags         = [local.managed_tag]
}

resource "netbox_device_primary_ip" "lab" {
  for_each      = local.lab_addresses
  device_id     = netbox_device.lab[each.key].id
  ip_address_id = each.key == "homepi4" ? netbox_ip_address.lab_wifi[each.key].id : netbox_ip_address.lab[each.key].id
}

resource "netbox_device_interface" "lab_wifi" {
  for_each  = toset(["cloudpi4", "homepi4"])
  device_id = netbox_device.lab[each.key].id
  name      = "wlan0"
  type      = "ieee802.11ac"
  tags      = [local.managed_tag]
}

resource "netbox_mac_address" "lab_wifi" {
  for_each            = netbox_device_interface.lab_wifi
  mac_address         = local.lab_clients.folly.rpis["${each.key}-wifi"].mac
  device_interface_id = each.value.id
  tags                = [local.managed_tag]
}

resource "netbox_ip_address" "lab_wifi" {
  for_each     = netbox_device_interface.lab_wifi
  ip_address   = "${cidrhost(local.lab_networks["folly-anchor"].prefix, local.lab_clients.folly.rpis["${each.key}-wifi"].ip)}/${split("/", local.lab_networks["folly-anchor"].prefix)[1]}"
  status       = "active"
  object_type  = "dcim.interface"
  interface_id = each.value.id
  tags         = [local.managed_tag]
}
