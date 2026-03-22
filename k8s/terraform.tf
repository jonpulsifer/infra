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

provider "helm" {
  alias = "offsite"
  kubernetes = {
    config_path    = "~/.kube/config"
    config_context = "offsite"
  }
}

provider "kubernetes" {
  config_path = "~/.kube/config"
}

provider "kubernetes" {
  alias          = "offsite"
  config_path    = "~/.kube/config"
  config_context = "offsite"
}

provider "github" {
  owner = local.github.org
}
