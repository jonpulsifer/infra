locals {
  github = {
    org  = "jonpulsifer"
    repo = "infra"
  }
}

resource "tls_private_key" "flux" {
  algorithm   = "ECDSA"
  ecdsa_curve = "P256"
}

resource "github_repository_deploy_key" "this" {
  title      = "Flux"
  repository = local.github.repo
  key        = tls_private_key.flux.public_key_openssh
  read_only  = "true"
}

resource "helm_release" "flux_operator" {
  name             = "flux-operator"
  namespace        = "flux-system"
  repository       = "oci://ghcr.io/controlplaneio-fluxcd/charts"
  chart            = "flux-operator"
  create_namespace = true
}

resource "helm_release" "flux" {
  depends_on = [helm_release.flux]

  name       = "flux"
  namespace  = "flux-system"
  repository = "oci://ghcr.io/controlplaneio-fluxcd/charts"
  chart      = "flux-instance"

  values = [
    file("folly.yaml")
  ]
}

resource "kubernetes_secret" "main" {

  metadata {
    name      = "flux-github-app-credentials"
    namespace = "flux-system"
  }

  data = {
    identity       = tls_private_key.flux.private_key_pem
    "identity.pub" = tls_private_key.flux.public_key_pem
    known_hosts    = "github.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg="
  }

  depends_on = [ helm_release.flux ]
}
