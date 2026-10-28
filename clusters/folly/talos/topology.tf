module "topology" {
  source = "../../../terraform/modules/cluster-topology"
  site   = "folly"
}

module "lab_topology" {
  source     = "../../../terraform/modules/cluster-topology"
  site       = "folly"
  config_map = "lab-topology"
}
