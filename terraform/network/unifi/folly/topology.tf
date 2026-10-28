# Reads the Flux ConfigMaps in clusters/<site>/config; edit the JSON, not this root.
module "topology" {
  source = "../../../modules/cluster-topology"
  site   = "folly"
}

module "offsite_topology" {
  source = "../../../modules/cluster-topology"
  site   = "offsite"
}

module "anchor_topology" {
  source     = "../../../modules/cluster-topology"
  site       = "folly"
  config_map = "anchor-topology"
}

locals {
  topology         = module.topology.data
  offsite_topology = module.offsite_topology.data
  anchor_topology  = module.anchor_topology.data

  # The nested shape this root uses, projected from the flat ConfigMap.
  anchor = {
    cidr = local.anchor_topology.ANCHOR_CIDR
    hosts = {
      capsule = local.anchor_topology.CAPSULE_IP
      spore   = local.anchor_topology.SPORE_IP
      forge   = local.anchor_topology.FORGE_IP
    }
  }

  # UniFi expects gateway-host CIDRs for network subnets.
  future_cidr = "${cidrhost(local.anchor_topology.FUTURE_CIDR, 1)}/${split("/", local.anchor_topology.FUTURE_CIDR)[1]}"
  lb_range    = local.topology.LB_RANGE
}
