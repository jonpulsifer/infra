# Reads clusters/<site>/config/cluster-topology.json; edit the JSON, not this root.
# Keys are the flat ConfigMap data, e.g. local.topology.folly.API_SERVER_IP.
module "topology" {
  for_each = toset(["folly", "offsite"])
  source   = "../../modules/cluster-topology"
  site     = each.key
}

locals {
  topology = { for site, m in module.topology : site => m.data }
}
