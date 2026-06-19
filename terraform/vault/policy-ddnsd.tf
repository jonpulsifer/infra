data "vault_policy_document" "ddnsd" {
  rule {
    path         = "home/unifi/google_ddns/*"
    capabilities = ["read", "list"]
    description  = "Read all unifi ddns secrets"
  }
}

resource "vault_policy" "ddnsd" {
  name   = "ddnsd"
  policy = data.vault_policy_document.ddnsd.hcl
}
