resource "vault_auth_backend" "gcp" {
  type        = "gcp"
  path        = "gcp"
  description = "Authenticate workloads running on GCP"
  tune {
    listing_visibility = "hidden"
  }
}

resource "vault_gcp_auth_backend_role" "ddnsd" {
  role                   = "ddnsd"
  type                   = "iam"
  backend                = vault_auth_backend.gcp.path
  bound_service_accounts = ["ddnsd-id@homelab-ng.iam.gserviceaccount.com"]
  token_policies         = ["ddnsd"]
}
