locals {
  common_labels = {
    terraform-managed = "true"
  }
  offsite_nodes = {
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
  for_each = local.offsite_nodes

  api_version = "v1"
  kind        = "Node"
  metadata {
    name = each.key
  }
  labels = each.value
}
