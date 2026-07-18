mock_provider "github" {}
mock_provider "helm" {}
mock_provider "kubernetes" {}
mock_provider "tls" {}

run "exposes_offsite_bootstrap_resources" {
  command = plan

  assert {
    condition = output.bootstrap_resources == {
      deploy_key = {
        repository = "infra"
        title      = "Flux (offsite)"
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
    error_message = "offsite bootstrap must expose its Flux deploy key, releases, and credentials secret"
  }
}
