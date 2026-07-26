output "bootstrap_resources" {
  description = "Stable identities of resources created for Flux bootstrap."

  value = {
    coredns = {
      cluster_role         = kubernetes_cluster_role_v1.coredns.metadata[0].name
      cluster_role_binding = kubernetes_cluster_role_binding_v1.coredns.metadata[0].name
      config_map           = "${kubernetes_config_map_v1.coredns.metadata[0].namespace}/${kubernetes_config_map_v1.coredns.metadata[0].name}"
      deployment           = "${kubernetes_deployment_v1.coredns.metadata[0].namespace}/${kubernetes_deployment_v1.coredns.metadata[0].name}"
      service              = "${kubernetes_service_v1.kube_dns.metadata[0].namespace}/${kubernetes_service_v1.kube_dns.metadata[0].name}"
      service_account      = "${kubernetes_service_account_v1.coredns.metadata[0].namespace}/${kubernetes_service_account_v1.coredns.metadata[0].name}"
    }
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
