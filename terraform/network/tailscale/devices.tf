# Keys are MagicDNS hostnames without the tailnet domain.
locals {
  tailnet_domain = local.fleet.tailnet

  devices = {
    "atomic" = {
      key_expiry_disabled = true
      tags                = []
    }
    "chromebook-a288" = {
      key_expiry_disabled = true
      tags                = []
    }
    "cloudpi4" = {
      key_expiry_disabled = true
      tags                = ["tag:pi4"]
    }
    "craftbook-air" = {
      key_expiry_disabled = false
      tags                = []
    }
    "desktop-g7i75ls" = {
      key_expiry_disabled = true
      tags                = ["tag:offsite"]
    }
    "homepi4" = {
      key_expiry_disabled = true
      tags                = ["tag:pi4"]
    }
    "nuc" = {
      key_expiry_disabled = true
      tags                = ["tag:folly"]
    }
    "oldschool" = {
      key_expiry_disabled = true
      tags                = ["tag:offsite"]
    }
    "optiplex" = {
      key_expiry_disabled = true
      tags                = ["tag:folly"]
    }
    "retrofit" = {
      key_expiry_disabled = true
      tags                = ["tag:offsite"]
    }
    "riptide" = {
      key_expiry_disabled = true
      tags                = ["tag:folly"]
    }
    "shale" = {
      key_expiry_disabled = true
      tags                = []
    }
    "spore" = {
      key_expiry_disabled = true
      tags                = ["tag:folly"]
    }
    "tallboy" = {
      key_expiry_disabled = true
      tags                = []
    }
    "tinytower" = {
      key_expiry_disabled = false
      tags                = []
    }
    "weatherpi4" = {
      key_expiry_disabled = true
      tags                = ["tag:pi4"]
    }
  }
}

data "tailscale_device" "devices" {
  for_each = local.devices
  name     = "${each.key}.${local.tailnet_domain}"
}

resource "tailscale_device_authorization" "devices" {
  for_each   = local.devices
  device_id  = data.tailscale_device.devices[each.key].node_id
  authorized = true
}

resource "tailscale_device_key" "devices" {
  for_each            = local.devices
  device_id           = data.tailscale_device.devices[each.key].node_id
  key_expiry_disabled = each.value.key_expiry_disabled
}

resource "tailscale_device_tags" "devices" {
  for_each  = { for k, v in local.devices : k => v if length(v.tags) > 0 }
  device_id = data.tailscale_device.devices[each.key].node_id
  tags      = each.value.tags

  # The API rejects a tag until the ACL's tagOwners lists it, and no reference
  # orders this after tailscale_acl.this.
  depends_on = [tailscale_acl.this]
}
