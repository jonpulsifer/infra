# The access points, imported as they are. Band steering and outdoor mode are
# declared where the console reports them; the radios stay computed until the
# radio plan lands in its own change.
locals {
  aps      = local.clients.aps
  ap_roles = toset(flatten([for ap in values(local.aps) : ap.roles]))
}

import {
  for_each = local.aps
  to       = unifi_device.ap[each.key]
  id       = each.value.mac
}

resource "unifi_device" "ap" {
  for_each = local.aps

  mac               = each.value.mac
  name              = each.key
  forget_on_destroy = false
  allow_adoption    = false

  bandsteering_mode     = try(each.value.band_steering, null)
  outdoor_mode_override = try(each.value.outdoor_mode, null)
}

# One group per role. A WLAN names the group whose APs should carry it.
resource "unifi_ap_group" "role" {
  for_each = { for role in local.ap_roles : role => [for ap in values(local.aps) : ap.mac if contains(ap.roles, role)] }

  name        = each.key
  device_macs = each.value
}

# The group the lab WLAN already uses, holding the office AP alone.
import {
  to = unifi_ap_group.lab_only
  id = "693c98563a6bcc1ba862e1ae"
}

resource "unifi_ap_group" "lab_only" {
  name        = "devices_ap_group"
  device_macs = [local.aps["Lab"].mac]
}
