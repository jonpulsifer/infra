# ---------------------------------------------------------------------------
# GitHub Actions workload identity federation.
#
# Lets the nixos-deploy workflow (.github/workflows/nixos-deploy.yaml) join
# the tailnet using a GitHub Actions OIDC token exchanged for a short-lived
# Tailscale auth key — no long-lived OAuth secret stored in GitHub. Scoped to
# tag:ci, which the ACL (policy.hujson) only allows to reach tag:pi4 over
# SSH.
# ---------------------------------------------------------------------------

resource "tailscale_federated_identity" "github_actions_nixos_deploy" {
  description = "github-actions nixos-deploy workflow"
  issuer      = "https://token.actions.githubusercontent.com"
  # Locked to main: a workflow_dispatch run against any other ref won't match
  # this subject, so the tailnet join fails (Tailscale-side auth error, not a
  # GitHub-side one) rather than deploying from an unmerged branch.
  subject = "repo:jonpulsifer/infra:ref:refs/heads/main"
  scopes  = ["auth_keys"]
  tags    = ["tag:ci"]

  custom_claim_rules = {
    job_workflow_ref = "jonpulsifer/infra/.github/workflows/nixos-deploy.yaml@refs/heads/main"
  }
}

output "github_actions_nixos_deploy_client_id" {
  description = "Set as the TS_OIDC_CLIENT_ID repository variable (not a secret — access is gated by the OIDC issuer/subject check, not by knowledge of this id)."
  value       = tailscale_federated_identity.github_actions_nixos_deploy.id
}

output "github_actions_nixos_deploy_audience" {
  description = "Set as the TS_OIDC_AUDIENCE repository variable."
  value       = tailscale_federated_identity.github_actions_nixos_deploy.audience
}
