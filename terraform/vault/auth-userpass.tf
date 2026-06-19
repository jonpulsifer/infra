resource "vault_auth_backend" "userpass" {
  type        = "userpass"
  path        = "userpass"
  description = "Authenticate with usernames and passwords"
  tune {
    listing_visibility = "unauth"
  }
}
