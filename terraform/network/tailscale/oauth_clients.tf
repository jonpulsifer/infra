# One revocable OAuth client per bare-metal host. After the apply, the operator
# copies the escrowed secret from 1Password into the host's SOPS file.

resource "tailscale_oauth_client" "forge_enrollment" {
  description = "forge enrollment"
  scopes      = ["auth_keys"]
  tags        = ["tag:lab-host"]

  # Tailscale rejects a tag-scoped OAuth client until the tag exists in the
  # tailnet policy.
  depends_on = [tailscale_acl.this]
}

resource "onepassword_item" "forge_tailscale_oauth" {
  vault    = local.vault_id
  title    = "tailscale OAuth (forge)"
  category = "login"
  username = tailscale_oauth_client.forge_enrollment.id

  # Write-only, so the escrow item adds no second copy of the key to state.
  password_wo         = tailscale_oauth_client.forge_enrollment.key
  password_wo_version = 1

  lifecycle {
    # A replaced client has a new secret; replace the escrow item in the same apply.
    replace_triggered_by = [tailscale_oauth_client.forge_enrollment]
  }

  tags = [
    "forge",
    "nixos",
    "tailscale",
  ]
}
