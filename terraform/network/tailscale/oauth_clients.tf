# ---------------------------------------------------------------------------
# Bare-metal host enrollment.
#
# Each host gets an independently revocable OAuth client restricted to the
# lab-host tag. The generated secret is escrowed directly into 1Password for
# the operator to copy into that host's SOPS file after Atlantis applies.
# ---------------------------------------------------------------------------

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

  # The Tailscale provider necessarily retains the generated key in its
  # resource state. Use 1Password's write-only field so the escrow resource
  # does not duplicate it in state.
  password_wo         = tailscale_oauth_client.forge_enrollment.key
  password_wo_version = 1

  lifecycle {
    # A replaced OAuth client has a new secret. Replace the write-only escrow
    # item in the same apply so it cannot retain the revoked client's value.
    replace_triggered_by = [tailscale_oauth_client.forge_enrollment]
  }

  tags = [
    "forge",
    "nixos",
    "tailscale",
  ]
}
