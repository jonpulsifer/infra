locals {
  common_labels = {
    terraform-managed = "true"
  }

  nodes_with_labels = {
    "nuc" = {
      "node-role.kubernetes.io/control-plane" = ""
      "bgp-enabled"                           = "true"
    },
    "800g2" = {
      "node-role.kubernetes.io/worker" = ""
      "bgp-enabled"                    = "true"
    },
    "riptide" = {
      "node-role.kubernetes.io/worker" = ""
      "bgp-enabled"                    = "true"
    },
    "optiplex" = {
      "node-role.kubernetes.io/worker" = ""
      "bgp-enabled"                    = "true"
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
  config_context = "local"
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
    flux = {
      source = "fluxcd/flux"
    }
    github = {
      source = "integrations/github"
    }
  }
}
