# Terraform makes a node's device and never updates it in place: netbox_device
# sends back on an update every custom field it last read, which would
# overwrite what talos-attest and fleet-controller wrote since. Its status
# starts planned and then belongs to the owner and fleet-controller.
resource "netbox_device" "node" {
  for_each = local.nodes

  name           = each.key
  site_id        = data.netbox_site.folly.id
  role_id        = data.netbox_device_role.node.id
  platform_id    = data.netbox_platform.talos.id
  device_type_id = netbox_device_type.node[each.value.model].id
  serial         = each.value.serial
  status         = "planned"
  tags           = [local.managed_tag]

  lifecycle {
    ignore_changes = all
  }

  depends_on = [netbox_interface_template.node]
}

# Each node's interface is the one NetBox made from its device type's template.
# A device NetBox already holds is looked up apart from netbox_device, so a
# plan that adds a node reads the others' interfaces now instead of at apply,
# and leaves their addresses and cables unchanged.
data "netbox_devices" "nodes" {
  filter {
    name  = "site_id"
    value = data.netbox_site.folly.id
  }
  filter {
    name  = "role_id"
    value = data.netbox_device_role.node.id
  }
}

locals {
  device_ids = { for d in data.netbox_devices.nodes.devices : d.name => d.device_id }
}

data "netbox_device_interfaces" "existing" {
  for_each = { for name, n in local.nodes : name => n if contains(keys(local.device_ids), name) }

  filter {
    name  = "device_id"
    value = local.device_ids[each.key]
  }
  filter {
    name  = "name"
    value = local.models[each.value.model].interface
  }
}

data "netbox_device_interfaces" "created" {
  for_each = { for name, n in local.nodes : name => n if !contains(keys(local.device_ids), name) }

  filter {
    name  = "device_id"
    value = netbox_device.node[each.key].id
  }
  filter {
    name  = "name"
    value = local.models[each.value.model].interface
  }
}

locals {
  node_interface = merge(
    { for name, d in data.netbox_device_interfaces.existing : name => one(d.interfaces).id },
    { for name, d in data.netbox_device_interfaces.created : name => one(d.interfaces).id },
  )
}

resource "netbox_ip_address" "node" {
  for_each = local.nodes

  ip_address   = "${each.value.address}/${local.node_prefix_length}"
  status       = "active"
  object_type  = "dcim.interface"
  interface_id = local.node_interface[each.key]
  tags         = [local.managed_tag]

  lifecycle {
    ignore_changes = [dns_name, description]
  }
}

resource "netbox_cable" "node" {
  for_each = local.nodes

  status = "connected"
  tags   = [local.managed_tag]

  a_termination {
    object_type = "dcim.interface"
    object_id   = local.node_interface[each.key]
  }
  b_termination {
    object_type = "dcim.interface"
    object_id   = local.switch_ports["Port ${each.value.switch_port}"]
  }

  # fleet-controller made surge's cable, with no tag.
  lifecycle {
    ignore_changes = [tags]
  }
}

# What git declares of a device after it exists: its serial, model, primary
# IPv4 and declared custom fields. A PATCH sends only these keys, so the fields
# the services write are never part of a request. Terraform writes them when a
# node is created or its entry changes, and does not read them back.
resource "restapi_object" "declared" {
  for_each = local.nodes

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

  data = jsonencode({
    serial      = each.value.serial
    device_type = tonumber(netbox_device_type.node[each.value.model].id)
    primary_ip4 = tonumber(netbox_ip_address.node[each.key].id)
    custom_fields = {
      talos_class          = each.value.class
      bmc_type             = each.value.bmc
      install_disk         = each.value.disk
      tpm_version          = each.value.tpm
      amt                  = each.value.amt
      secure_boot_expected = each.value.secure_boot
      expected_port        = tonumber(each.value.switch_port)
    }
  })
}
