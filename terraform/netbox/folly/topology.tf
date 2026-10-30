# Reads the Flux ConfigMaps in clusters/folly/config; edit the JSON, not this root.
module "topology" {
  source = "../../modules/cluster-topology"
  site   = "folly"
}

module "anchor_topology" {
  source     = "../../modules/cluster-topology"
  site       = "folly"
  config_map = "anchor-topology"
}

locals {
  topology        = module.topology.data
  anchor_topology = module.anchor_topology.data
}
