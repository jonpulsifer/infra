# Network single source of truth. Edit the cluster-topology ConfigMap at
# clusters/offsite/config/cluster-topology.json (that JSON file IS the Flux
# ConfigMap and the shared facts), not the values that reference local.topology
# here. Keys are the flat ConfigMap data, e.g. local.topology.K8S_NODE_CIDR.
locals {
  topology = jsondecode(file("${path.module}/../../../../clusters/offsite/config/cluster-topology.json")).data
  # Derived: LB_RANGE is split off K8S_NODE_CIDR by UniFi; it's not a separate
  # ConfigMap key, so we compute it here from the SSOT's node CIDR.
  # K8S_NODE_CIDR = "10.89.0.0/28" → LB_RANGE = "10.89.0.64/26"
  lb_range = cidrsubnet(local.topology.K8S_NODE_CIDR, 2, 1)
}
