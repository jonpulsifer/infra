locals {
  common_labels = {
    terraform-managed = "true"
  }
  folly_nodes = {
    "riptide" = {
      "node-role.kubernetes.io/worker" = ""
      "bgp-enabled"                    = "true"
    },
    "optiplex" = {
      "node-role.kubernetes.io/control-plane" = ""
      "bgp-enabled"                           = "true"
    },
    "shale" = {
      "node-role.kubernetes.io/worker" = ""
      "bgp-enabled"                    = "true"
    },
  }
}

resource "kubernetes_labels" "nodes" {
  for_each = local.folly_nodes

  api_version = "v1"
  kind        = "Node"
  metadata {
    name = each.key
  }
  labels = each.value
}
