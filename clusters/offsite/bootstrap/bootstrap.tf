terraform {
  backend "gcs" {
    bucket = "homelab-ng"
    prefix = "clusters/offsite/bootstrap"
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
    config_path    = "~/.kube/config"
    config_context = "offsite"
  }
}

provider "kubernetes" {
  config_path    = "~/.kube/config"
  config_context = "offsite"
}

provider "github" {
  owner = local.github.org
}

locals {
  github = {
    org  = "jonpulsifer"
    repo = "infra"
  }
}

module "flux_bootstrap" {
  source = "../../../terraform/modules/flux-bootstrap"

  cluster_name = "offsite"
  github_repo  = local.github.repo
  flux_values  = file("${path.module}/flux-values.yaml")

  providers = {
    github     = github
    helm       = helm
    kubernetes = kubernetes
  }
}

moved {
  from = tls_private_key.flux
  to   = module.flux_bootstrap.tls_private_key.flux
}

moved {
  from = github_repository_deploy_key.this
  to   = module.flux_bootstrap.github_repository_deploy_key.this
}

moved {
  from = helm_release.flux_operator
  to   = module.flux_bootstrap.helm_release.flux_operator
}

moved {
  from = helm_release.flux
  to   = module.flux_bootstrap.helm_release.flux
}

moved {
  from = kubernetes_secret.main
  to   = module.flux_bootstrap.kubernetes_secret.main
}

output "bootstrap_resources" {
  description = "Stable identities of resources created for Flux bootstrap."
  value       = module.flux_bootstrap.bootstrap_resources
}
