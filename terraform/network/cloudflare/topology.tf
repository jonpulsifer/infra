# Network single source of truth: the cluster-topology module reads the
# per-cluster ConfigMaps at clusters/<site>/config/cluster-topology.json
# (those JSON files ARE the Flux ConfigMaps and the shared facts). Edit the
# JSON, not the values that reference local.topology here. Keys are the flat
# ConfigMap data, e.g. local.topology.folly.API_SERVER_IP.
module "topology" {
  for_each = toset(["folly", "offsite"])
  source   = "../../modules/cluster-topology"
  site     = each.key
}

locals {
  topology = { for site, m in module.topology : site => m.data }
}
