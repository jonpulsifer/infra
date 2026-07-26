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
    onepassword = {
      source  = "1password/onepassword"
      version = "~> 3.0"
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

  app_auth {
    id              = jsondecode(ephemeral.onepassword_item.github_app.note_value).app_id
    installation_id = jsondecode(ephemeral.onepassword_item.github_app.note_value).installation_id
    pem_file        = jsondecode(ephemeral.onepassword_item.github_app.note_value).private_key
  }
}

provider "onepassword" {}

locals {
  vault_id = "ib23znjeikv74p37f6mbfk7uya"
  github = {
    org  = "jonpulsifer"
    repo = "infra"
  }
}

ephemeral "onepassword_item" "github_app" {
  vault = local.vault_id
  uuid  = "gppbidlscm4tb5k5wpjhen7zhu"
}

module "topology" {
  source = "../../../terraform/modules/cluster-topology"
  site   = "offsite"
}

module "flux_bootstrap" {
  source = "../../../terraform/modules/flux-bootstrap"

  cluster_name = "offsite"
  github_repo  = local.github.repo
  flux_values  = file("${path.module}/flux-values.yaml")
  cluster_dns  = module.topology.data.CLUSTER_DNS
  router_ip    = module.topology.data.ROUTER_IP

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
