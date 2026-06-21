# ---------------------------------------------------------------------------
# Device map — single source of truth for all tailnet devices.
#
# Each key is the MagicDNS hostname (without the tailnet domain).
# Adding or removing a device only requires editing this map.
#
# Fields:
#   key_expiry_disabled  - set true for infra/servers, false for personal devices
#   tags                 - ACL tags to apply; empty list = no tailscale_device_tags resource
# ---------------------------------------------------------------------------

locals {
  tailnet_domain = "pirate-musical.ts.net"

  devices = {
    "atomic" = {
      key_expiry_disabled = true
      tags                = []
    }
    "chromebook-a288" = {
      key_expiry_disabled = false
      tags                = []
    }
    "cloudpi4" = {
      key_expiry_disabled = true
      tags                = []
    }
    "craftbook-air" = {
      key_expiry_disabled = false
      tags                = []
    }
    "desktop-g7i75ls" = {
      key_expiry_disabled = true
      tags                = ["tag:offsite"]
    }
    "folly-k8s-lan-router-0-1" = {
      key_expiry_disabled = true
      tags                = ["tag:folly", "tag:k8s", "tag:k8s-folly"]
    }
    "homepi4" = {
      key_expiry_disabled = true
      tags                = []
    }
    "nuc" = {
      key_expiry_disabled = true
      tags                = ["tag:folly"]
    }
    "offsite-k8s-lan-router-0" = {
      key_expiry_disabled = true
      tags                = ["tag:k8s", "tag:k8s-offsite", "tag:offsite"]
    }
    "oldboy" = {
      key_expiry_disabled = false
      tags                = []
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
      key_expiry_disabled = false
      tags                = []
    }
    "spore" = {
      key_expiry_disabled = true
      tags                = ["tag:folly"]
    }
    # tailscale-operator runs on both clusters (folly + offsite) and may have a
    # stale third registration. Tailscale deduplicates with numeric suffixes;
    # verify actual MagicDNS names in the console if these fail to resolve.
    "tailscale-operator" = {
      key_expiry_disabled = true
      tags                = ["tag:k8s-operator"]
    }
    "tailscale-operator-2" = {
      key_expiry_disabled = true
      tags                = ["tag:k8s-operator"]
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
      tags                = []
    }
  }
}

# ---------------------------------------------------------------------------
# Data sources — one lookup per device, keyed by MagicDNS hostname.
# ---------------------------------------------------------------------------

data "tailscale_device" "devices" {
  for_each = local.devices
  name     = "${each.key}.${local.tailnet_domain}"
}

# ---------------------------------------------------------------------------
# Authorize all devices.
# ---------------------------------------------------------------------------

resource "tailscale_device_authorization" "devices" {
  for_each   = local.devices
  device_id  = data.tailscale_device.devices[each.key].node_id
  authorized = true
}

# ---------------------------------------------------------------------------
# Key expiry — controlled per device via the map.
# ---------------------------------------------------------------------------

resource "tailscale_device_key" "devices" {
  for_each            = local.devices
  device_id           = data.tailscale_device.devices[each.key].node_id
  key_expiry_disabled = each.value.key_expiry_disabled
}

# ---------------------------------------------------------------------------
# Tags — only applied to devices that have a non-empty tags list.
# ---------------------------------------------------------------------------

resource "tailscale_device_tags" "devices" {
  for_each  = { for k, v in local.devices : k => v if length(v.tags) > 0 }
  device_id = data.tailscale_device.devices[each.key].node_id
  tags      = each.value.tags
}
