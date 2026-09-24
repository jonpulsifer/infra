# Reads clusters/offsite/config/cluster-topology.json; edit the JSON, not this root.
# Keys are the flat ConfigMap data, e.g. local.topology.K8S_NODE_CIDR.
module "topology" {
  source = "../../../modules/cluster-topology"
  site   = "offsite"
}

locals {
  topology = module.topology.data
  lb_range = local.topology.LB_RANGE
}
