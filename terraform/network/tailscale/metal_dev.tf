# The metal-dev VM trades its service account's Google identity token for a short-lived auth key
# at boot (metal-dev-tailscale-up in nix/hosts/metal-dev.nix). policy.hujson grants tag:gcp nothing.

# terraform/metal-dev declares this account. Read live so its unique id is never copied here.
data "google_service_account" "metal_dev" {
  account_id = "metal-dev"
}

resource "tailscale_federated_identity" "metal_dev" {
  description = "metal-dev VM"
  issuer      = "https://accounts.google.com"
  # A Compute Engine identity token's sub is the service account's numeric unique id.
  subject = data.google_service_account.metal_dev.unique_id
  scopes  = ["auth_keys"]
  tags    = ["tag:gcp"]

  # The VM asks for format=full, which carries the email claim.
  custom_claim_rules = {
    email = data.google_service_account.metal_dev.email
  }

  # The API rejects tag:gcp until the ACL's tagOwners lists it.
  depends_on = [tailscale_acl.this]
}

output "metal_dev_client_id" {
  description = "Set as tailscale_client_id in terraform/metal-dev/variables.tf (not a secret: the issuer, subject and email claim gate the exchange)."
  value       = tailscale_federated_identity.metal_dev.id
}

output "metal_dev_audience" {
  description = "Set as tailscale_audience in terraform/metal-dev/variables.tf."
  value       = tailscale_federated_identity.metal_dev.audience
}
