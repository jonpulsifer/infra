locals {
  inventory = yamldecode(file("${path.module}/../../../clusters/folly/inventory/nodes.yaml"))
  models    = local.inventory.models

  # Each node with its model's defaults under its own fields.
  nodes = { for name, n in local.inventory.nodes : name => merge(
    { for k, v in lookup(local.models, n.model, {}) : k => v if contains(["disk", "tpm", "amt", "secure_boot"], k) },
    n,
  ) }

  node_prefix_length = split("/", local.topology.K8S_NODE_CIDR)[1]
  classes            = ["controlplane", "worker-g5", "worker-g2"]
  bmc_types          = ["amt", "none"]
}
