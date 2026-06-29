# Network single source of truth. Edit the cluster-topology ConfigMap at
# clusters/folly/config/cluster-topology.json (that JSON file IS the Flux
# ConfigMap and the shared facts), not the values that reference local.topology
# here. Keys are the flat ConfigMap data, e.g. local.topology.K8S_NODE_CIDR.
locals {
  topology = jsondecode(file("${path.module}/../../../clusters/folly/config/cluster-topology.json")).data
}
