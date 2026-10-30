resource "netbox_site" "oldschool" {
  name        = "oldschool"
  slug        = "oldschool"
  description = "The remote lab site; offsite in cluster and network configuration"
  status      = "active"
  tags        = [local.managed_tag]

  depends_on = [netbox_permission.terraform_manage]
}

locals {
  lab_sites = {
    folly     = data.netbox_site.folly.id
    oldschool = netbox_site.oldschool.id
  }
  racks = {
    folly = {
      name        = "folly-12u"
      description = "StarTech 4POSTRACK12U, 12U 19-inch four-post rack"
      height      = 12
      width       = 19
      form_factor = "4-post-frame"
    }
    oldschool = {
      name        = "oldschool-8u"
      description = "GeeekPi 8U Network Rack, 10-inch"
      height      = 8
      width       = 10
      form_factor = null
    }
  }
}

resource "netbox_rack" "lab" {
  for_each = local.racks

  name        = each.value.name
  site_id     = local.lab_sites[each.key]
  description = each.value.description
  u_height    = each.value.height
  width       = each.value.width
  form_factor = each.value.form_factor
  status      = "active"
  tags        = [local.managed_tag]

  depends_on = [netbox_permission.terraform_manage]
}
