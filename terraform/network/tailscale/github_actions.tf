# nixos-deploy.yaml trades its GitHub OIDC token for a short-lived auth key.
# policy.hujson lets tag:ci reach only tag:pi4, over SSH.

resource "tailscale_federated_identity" "github_actions_nixos_deploy" {
  description = "github-actions nixos-deploy workflow"
  issuer      = "https://token.actions.githubusercontent.com"
  # Locked to main: a dispatch from any other ref fails the tailnet join.
  subject = "repo:jonpulsifer@5461940/infra@952814997:ref:refs/heads/main"
  scopes  = ["auth_keys"]
  tags    = ["tag:ci"]

  custom_claim_rules = {
    job_workflow_ref = "jonpulsifer/infra/.github/workflows/nixos-deploy.yaml@refs/heads/main"
  }

  # The API rejects tag:ci until the ACL's tagOwners lists it.
  depends_on = [tailscale_acl.this]
}

output "github_actions_nixos_deploy_client_id" {
  description = "Set as the TS_OIDC_CLIENT_ID repository variable (not a secret — access is gated by the OIDC issuer/subject check, not by knowledge of this id)."
  value       = tailscale_federated_identity.github_actions_nixos_deploy.id
}

output "github_actions_nixos_deploy_audience" {
  description = "Set as the TS_OIDC_AUDIENCE repository variable."
  value       = tailscale_federated_identity.github_actions_nixos_deploy.audience
}
