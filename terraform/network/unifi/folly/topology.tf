# Network single sources of truth: the topology module reads Flux ConfigMaps
# from clusters/<site>/config. Edit those JSON resources, not the projections
# below.
module "topology" {
  source = "../../../modules/cluster-topology"
  site   = "folly"
}

module "offsite_topology" {
  source = "../../../modules/cluster-topology"
  site   = "offsite"
}

module "lab_topology" {
  source     = "../../../modules/cluster-topology"
  site       = "folly"
  config_map = "lab-topology"
}

locals {
  topology         = module.topology.data
  offsite_topology = module.offsite_topology.data
  lab_topology     = module.lab_topology.data

  # Preserve the attribute shape used throughout this root while sourcing every
  # value from the flat Flux ConfigMap.
  lab = {
    cidr = local.lab_topology.LAB_CIDR
    hosts = {
      capsule = local.lab_topology.CAPSULE_IP
      spore   = local.lab_topology.SPORE_IP
      forge   = local.lab_topology.FORGE_IP
    }
  }

  # UniFi expects gateway-host CIDRs for network subnets.
  future_cidr = "${cidrhost(local.lab_topology.FUTURE_CIDR, 1)}/${split("/", local.lab_topology.FUTURE_CIDR)[1]}"
  lb_range    = local.topology.LB_RANGE
}
