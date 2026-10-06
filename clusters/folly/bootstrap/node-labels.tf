# Talos sets bgp-enabled through KubeNodeConfig in
# terraform/modules/talos-cluster. This root forgets kubernetes_labels.nodes
# from its state and leaves the labels on the nodes.
removed {
  from = kubernetes_labels.nodes

  lifecycle {
    destroy = false
  }
}
