module "topology" {
  source = "../../../terraform/modules/cluster-topology"
  site   = "folly"
}

module "anchor_topology" {
  source     = "../../../terraform/modules/cluster-topology"
  site       = "folly"
  config_map = "anchor-topology"
}
