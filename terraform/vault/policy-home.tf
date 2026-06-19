data "vault_policy_document" "home" {
  rule {
    path         = "home/*"
    capabilities = ["read", "list"]
    description  = "Read all home secrets"
  }
}

resource "vault_policy" "home" {
  name   = "home"
  policy = data.vault_policy_document.home.hcl
}
