variable "nodes_file" {
  description = "The nodes file, relative to this root. Only a test names another."
  type        = string
  default     = "../../../clusters/folly/inventory/nodes.yaml"
}

locals {
  inventory = yamldecode(file("${path.module}/${var.nodes_file}"))
  models    = local.inventory.models

  # Each node with its model's defaults under its own fields.
  nodes = { for name, n in local.inventory.nodes : name => merge(
    { for k, v in lookup(local.models, n.model, {}) : k => v if contains(["disk", "tpm", "amt", "secure_boot"], k) },
    n,
  ) }

  # A node's approved EK binding, one optional key per EK algorithm, and
  # every hash the nodes file approves.
  approved_ek_keys = ["approved_ek_rsa2048", "approved_ek_eccp256"]
  approved_eks     = flatten([for n in values(local.nodes) : [for k in local.approved_ek_keys : n[k] if lookup(n, k, null) != null]])

  # Each declared install disk serial. It is per disk, so it is the node's own
  # and never its model's; a node without one gets no Workflow that wipes.
  disk_serials = [for n in values(local.nodes) : n.disk_serial if lookup(n, "disk_serial", null) != null]

  node_prefix_length = split("/", local.topology.K8S_NODE_CIDR)[1]
  classes            = ["controlplane", "worker-g5", "worker-g2"]
  bmc_types          = ["amt", "none"]
}
