# The NetBox IDs of the objects scripts/netbox-seed.sh and scripts/netbox-declare.sh
# made before this root, so its first apply adopts them instead of making copies.
locals {
  imported = {
    devices      = { optiplex = 2, shale = 3, riptide = 4, swell = 8, surge = 9 }
    ip_addresses = { optiplex = 1, shale = 2, riptide = 3, swell = 7, surge = 8 }
    cables       = { optiplex = 1, shale = 2, riptide = 3, swell = 7, surge = 8 }
    device_types = { dell-optiplex-3050 = 3, hp-elitedesk-800-g2-dm-35w = 1, hp-elitedesk-800-g5-desktop-mini = 2 }
    templates    = { dell-optiplex-3050 = 3, hp-elitedesk-800-g2-dm-35w = 1, hp-elitedesk-800-g5-desktop-mini = 2 }
    choice_sets  = { talos-class = 1, bmc-type = 2, desired-action = 3 }
    custom_fields = {
      bios_version         = 1
      sku                  = 2
      install_disk         = 3
      amt                  = 4
      secure_boot_expected = 5
      tpm_version          = 6
      ek_hash              = 7
      ek_issuer            = 8
      ldevid_serial        = 9
      ldevid_not_after     = 10
      lak_serial           = 11
      last_attested        = 12
      ek_hash_ecc          = 13
      attest_verdict       = 14
      attest_consumed_at   = 15
      talos_class          = 16
      bmc_type             = 17
      desired_action       = 18
      last_workflow        = 19
      smbios_uuid          = 20
      pcr0_by_bios         = 21
      attested_address     = 22
      attested_switch      = 23
      attested_switch_port = 24
      attested_network_at  = 25
      expected_port        = 26
    }
  }
}

import {
  for_each = local.imported.devices
  to       = netbox_device.node[each.key]
  id       = each.value
}

import {
  for_each = local.imported.ip_addresses
  to       = netbox_ip_address.node[each.key]
  id       = each.value
}

import {
  for_each = local.imported.cables
  to       = netbox_cable.node[each.key]
  id       = each.value
}

import {
  for_each = local.imported.device_types
  to       = netbox_device_type.node[each.key]
  id       = each.value
}

import {
  for_each = local.imported.templates
  to       = netbox_interface_template.node[each.key]
  id       = each.value
}

import {
  for_each = local.imported.choice_sets
  to       = netbox_custom_field_choice_set.fleet[each.key]
  id       = each.value
}

import {
  for_each = { for name, id in local.imported.custom_fields : name => id if local.custom_fields[name].type != "datetime" }
  to       = netbox_custom_field.device[each.key]
  id       = each.value
}

import {
  for_each = { for name, id in local.imported.custom_fields : name => id if local.custom_fields[name].type == "datetime" }
  to       = restapi_object.datetime_field[each.key]
  id       = "/extras/custom-fields/${each.value}"
}

import {
  to = netbox_webhook.fleet_controller
  id = "1"
}

import {
  to = netbox_event_rule.fleet_controller
  id = "1"
}
