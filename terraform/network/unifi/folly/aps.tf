# The access points. Band steering and outdoor mode are declared where the
# console reports them. An AP with a `radios` list in clients.yaml owns its
# radio table in git; the others keep whatever the console holds.
#
# A change to clients.yaml alone gets no autoplan: comment
# `atlantis plan -d terraform/network/unifi/folly` on the pull request and
# wait for the plan before merging. A minimum RSSI on an outdoor radio drops
# an idle IoT client before it reports a signal; the Tempest hub proved it.
# The provider omits a false boolean from a radio write, so a floor is turned
# off by setting it to −90, never by min_rssi_enabled = false.
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
  radio_table           = try(each.value.radios, null)
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
