# Network single source of truth. Edit the cluster-topology ConfigMap at
# clusters/<site>/config/cluster-topology.json (that JSON file IS the Flux
# ConfigMap and the shared facts), not the values that reference it. Keys are
# the flat ConfigMap data, e.g. data.K8S_NODE_CIDR.
locals {
  data = jsondecode(file("${path.module}/../../../clusters/${var.site}/config/cluster-topology.json")).data
}
