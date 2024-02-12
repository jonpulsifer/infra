locals {
  github = {
    org  = "jonpulsifer"
    repo = "infra"
  }
}

provider "github" {
  owner = local.github.org
  # token = "" or GH_TOKEN env
  # export GH_TOKEN=$(op item get 'fluxcd pat' --fields=password --account=pulsifer)
}

resource "tls_private_key" "flux" {
  algorithm   = "ECDSA"
  ecdsa_curve = "P256"
}

resource "github_repository_deploy_key" "this" {
  title      = "Flux"
  repository = local.github.repo
  key        = tls_private_key.flux.public_key_openssh
  read_only  = "false"
}

provider "flux" {
  kubernetes = {
    config_path = "~/.kube/config"
  }
  git = {
    url = "ssh://git@github.com/${local.github.org}/${local.github.repo}.git"
    ssh = {
      username    = "git"
      private_key = tls_private_key.flux.private_key_pem
    }
  }
}

resource "flux_bootstrap_git" "this" {
  depends_on = [github_repository_deploy_key.this]
  path       = "k8s/flux"
}
