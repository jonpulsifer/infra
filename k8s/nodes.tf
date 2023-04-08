locals {
  common_labels = {
    terraform-managed = "true"
  }

  nodes_with_labels = {
    "nuc" = {
      "node-role.kubernetes.io/control-plane" = ""
    },
    "800g2" = {
      "node-role.kubernetes.io/worker" = ""
      "bgp.lolwtf.ca/peer"             = "800g2"
    },
    "800g2-2" = {
      "node-role.kubernetes.io/worker" = ""
      "bgp.lolwtf.ca/peer"             = "800g2-2"
    },
    "800g3-1" = {
      "node-role.kubernetes.io/worker" = ""
      "bgp.lolwtf.ca/peer"             = "800g3-1"
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

provider "kubernetes" {
  config_path    = "~/.kube/config"
  config_context = "home"
}

terraform {
  backend "gcs" {
    bucket = "homelab-ng"
    prefix = "terraform/k8s"
  }
  required_providers {
    kubernetes = {
      source = "hashicorp/kubernetes"
    }
  }
}
