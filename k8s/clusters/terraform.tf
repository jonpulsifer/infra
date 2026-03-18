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
    helm = {
      source = "hashicorp/helm"
    }
    github = {
      source = "integrations/github"
    }
  }
}

provider "helm" {
  kubernetes = {
    config_path = "~/.kube/config"
  }
}

provider "kubernetes" {
  config_path = "~/.kube/config"
}

provider "github" {
  owner = local.github.org
}
