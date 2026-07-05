# Network single source of truth. Edit the per-cluster cluster-topology
# ConfigMaps at clusters/<site>/config/cluster-topology.json (those JSON files
# ARE the Flux ConfigMaps and the shared facts), not the values that reference
# local.topology here. Keys are the flat ConfigMap data, e.g.
# local.topology.folly.API_SERVER_IP.
locals {
  topology = {
    folly   = jsondecode(file("${path.module}/../../../clusters/folly/config/cluster-topology.json")).data
    offsite = jsondecode(file("${path.module}/../../../clusters/offsite/config/cluster-topology.json")).data
  }
}
