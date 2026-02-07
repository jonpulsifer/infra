ephemeral "onepassword_item" "google_oauth_client" {
  vault = local.vault_id
  uuid  = "ynzbgrzrq3enshs37j72g7enhe"
}

resource "vault_jwt_auth_backend" "google" {
  description        = "Authenticate with Google"
  path               = "google"
  type               = "oidc"
  oidc_discovery_url = "https://accounts.google.com"
  oidc_client_id     = ephemeral.onepassword_item.google_oauth_client.username
  oidc_client_secret = ephemeral.onepassword_item.google_oauth_client.password
  default_role       = "google-default"
  tune {
    allowed_response_headers     = []
    audit_non_hmac_request_keys  = []
    audit_non_hmac_response_keys = []
    default_lease_ttl            = "768h"
    listing_visibility           = "unauth"
    max_lease_ttl                = "768h"
    passthrough_request_headers  = []
    token_type                   = "default-service"
  }
  provider_config = {
    "provider" : "gsuite",
    "gsuite_service_account" : "/var/run/secrets/vault/credentials.json",
    # "gsuite_admin_impersonate" : "vault@pulsifer.ca",
    "fetch_groups" : true,
    "fetch_user_info" : true,
  }
}

resource "vault_jwt_auth_backend_role" "google_default" {
  backend        = vault_jwt_auth_backend.google.path
  role_type      = "oidc"
  role_name      = "google-default"
  token_policies = ["default"]
  allowed_redirect_uris = [
    "https://vault.lolwtf.ca/ui/vault/auth/google/oidc/callback",
    "http://localhost:8250/oidc/callback",
  ]
  user_claim           = "sub"
  bound_audiences      = [ephemeral.onepassword_item.google_oauth_client.username]
  verbose_oidc_logging = true
}
