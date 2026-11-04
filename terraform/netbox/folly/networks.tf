locals {
  network_catalogs = {
    folly     = jsondecode(file("${path.module}/../../network/unifi/folly/network-catalog.json"))
    oldschool = jsondecode(file("${path.module}/../../network/unifi/offsite/network-catalog.json"))
  }
  lab_networks = merge({
    for key, network in local.network_catalogs.folly : "folly-${key}" => {
      site = "folly"
      name = network.name
      prefix = key == "management" || key == "iot" ? network.subnet : key == "kubernetes" ? local.topology.K8S_NODE_CIDR : local.anchor_topology[{
        anchor = "ANCHOR_CIDR", future = "FUTURE_CIDR", bootstrap = "BOOTSTRAP_CIDR"
      }[key]]
      vlan = key == "bootstrap" ? tonumber(local.anchor_topology.BOOTSTRAP_VLAN) : try(network.vlan, null)
    }
    }, {
    for key, network in local.network_catalogs.oldschool : "oldschool-${key}" => {
      site   = "oldschool"
      name   = network.name
      prefix = key == "default" ? network.subnet : module.oldschool_topology.data.K8S_NODE_CIDR
      vlan   = try(network.vlan, null)
    }
  })
  # The seed already holds folly's topology prefixes; this root adds missing ranges.
  missing_prefixes = merge({ for k, v in local.lab_networks : k => v if startswith(k, "oldschool-") || contains(["folly-management", "folly-iot"], k) }, {
    for key in ["CILIUM_POD_CIDR", "SERVICE_CIDR", "LB_RANGE"] : "oldschool-${key}" => {
      site = "oldschool", name = key, prefix = module.oldschool_topology.data[key], vlan = null
    }
  })
}

resource "netbox_vlan" "lab" {
  for_each   = { for k, v in local.lab_networks : k => v if v.vlan != null }
  name       = each.value.name
  vid        = each.value.vlan
  site_id    = local.lab_sites[each.value.site]
  status     = "active"
  tags       = [local.managed_tag]
  depends_on = [netbox_permission.terraform_manage]
}

resource "netbox_prefix" "lab" {
  for_each    = local.missing_prefixes
  prefix      = cidrsubnet(each.value.prefix, 0, 0)
  site_id     = local.lab_sites[each.value.site]
  description = each.value.name
  vlan_id     = try(netbox_vlan.lab[each.key].id, null)
  status      = "active"
  tags        = [local.managed_tag]
  depends_on  = [netbox_permission.terraform_manage]
}
