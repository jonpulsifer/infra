output "bootstrap_resources" {
  description = "Stable identities of resources created for Flux bootstrap."

  value = {
    deploy_key = {
      repository = github_repository_deploy_key.this.repository
      title      = github_repository_deploy_key.this.title
    }
    flux = {
      name      = helm_release.flux.name
      namespace = helm_release.flux.namespace
    }
    flux_operator = {
      name      = helm_release.flux_operator.name
      namespace = helm_release.flux_operator.namespace
    }
    github_credentials_secret = {
      name      = kubernetes_secret.main.metadata[0].name
      namespace = kubernetes_secret.main.metadata[0].namespace
    }
  }
}
