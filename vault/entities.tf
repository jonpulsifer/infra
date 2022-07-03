resource "vault_identity_entity" "jawn" {
  name = "jawn"
  policies = [
    "godmode",
    "home"
  ]
}

resource "vault_identity_entity" "terraform" {
  name = "terraform"
  policies = [
    "default",
    "home"
  ]
}

resource "vault_identity_entity_alias" "terraform" {
  name           = "terraform alias"
  mount_accessor = vault_auth_backend.approle.accessor
  canonical_id   = vault_identity_entity.terraform.id
}

resource "vault_identity_entity_alias" "jawn" {
  name           = "jawn"
  mount_accessor = vault_auth_backend.userpass.accessor
  canonical_id   = vault_identity_entity.jawn.id
}
