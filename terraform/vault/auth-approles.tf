resource "vault_auth_backend" "approle" {
  type        = "approle"
  path        = "approle"
  description = "Authenticate with static credentials"
}

resource "vault_approle_auth_backend_role" "terraform" {
  backend        = vault_auth_backend.approle.path
  role_name      = "terraform"
  token_policies = ["terraform", "default"]
}

resource "vault_approle_auth_backend_role" "cert_manager" {
  backend        = vault_auth_backend.approle.path
  role_name      = "cert-manager"
  token_policies = ["cert-manager"]
}

resource "vault_approle_auth_backend_role" "home" {
  backend               = vault_auth_backend.approle.path
  role_name             = "home"
  secret_id_bound_cidrs = []
  token_policies        = ["home", "default"]
}

resource "vault_approle_auth_backend_role_secret_id" "home" {
  backend   = vault_auth_backend.approle.path
  role_name = vault_approle_auth_backend_role.home.role_name
}

output "home_approle" {
  value = vault_approle_auth_backend_role.home.role_id
}

output "home_approle_secret" {
  sensitive = true
  value     = vault_approle_auth_backend_role_secret_id.home.secret_id
}
