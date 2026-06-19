locals {
  common_labels = {
    terraform-managed = "true"
  }

  nodes_with_labels = {
    "riptide" = {
      "node-role.kubernetes.io/worker" = ""
      "bgp-enabled"                    = "true"
    },
    "optiplex" = {
      "node-role.kubernetes.io/control-plane" = ""
      "bgp-enabled"                           = "true"
    },
    "oldschool" = {
      "node-role.kubernetes.io/worker" = ""
      "bgp-enabled"                    = "true"

    },
    "retrofit" = {
      "node-role.kubernetes.io/control-plane" = ""
      "bgp-enabled"                           = "true"
    }
  }
}

resource "kubernetes_labels" "nodes" {
  for_each = local.nodes_with_labels

  api_version = "v1"
  kind        = "Node"
  metadata {
    name = each.key
  }
  labels = each.value
}

