mock_provider "github" {}
mock_provider "helm" {}
mock_provider "kubernetes" {}
mock_provider "tls" {}

run "exposes_folly_bootstrap_resources" {
  command = plan

  assert {
    condition = output.bootstrap_resources == {
      coredns = {
        cluster_role         = "system:coredns"
        cluster_role_binding = "system:coredns"
        config_map           = "kube-system/coredns"
        deployment           = "kube-system/coredns"
        service              = "kube-system/kube-dns"
        service_account      = "kube-system/coredns"
      }
      deploy_key = {
        repository = "infra"
        title      = "Flux (folly)"
      }
      flux = {
        name      = "flux"
        namespace = "flux-system"
      }
      flux_operator = {
        name      = "flux-operator"
        namespace = "flux-system"
      }
      github_credentials_secret = {
        name      = "flux-github-app-credentials"
        namespace = "flux-system"
      }
    }
    error_message = "folly bootstrap must expose CoreDNS and its Flux bootstrap resources"
  }
}
