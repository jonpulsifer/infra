data "vault_policy_document" "godmode" {
  rule {
    path         = "*"
    capabilities = ["create", "read", "update", "delete", "list", "sudo"]
    description  = "-=[*] g0Dm0d3 [*]=-"
  }
}

resource "vault_policy" "godmode" {
  name   = "godmode"
  policy = data.vault_policy_document.godmode.hcl
}
