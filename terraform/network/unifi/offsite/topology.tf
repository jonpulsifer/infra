# Network single source of truth: the cluster-topology module reads
# clusters/offsite/config/cluster-topology.json (that JSON file IS the Flux
# ConfigMap and the shared facts). Edit the JSON, not the values that
# reference local.topology here. Keys are the flat ConfigMap data,
# e.g. local.topology.K8S_NODE_CIDR.
module "topology" {
  source = "../../../modules/cluster-topology"
  site   = "offsite"
}

locals {
  topology = module.topology.data
  # LB_RANGE is a declared cluster-topology fact, consumed directly by UniFi.
  lb_range = local.topology.LB_RANGE
}
