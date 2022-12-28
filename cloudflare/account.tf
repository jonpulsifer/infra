resource "cloudflare_account" "fml" {
  name              = "Folly Mountain Laboratories"
  type              = "standard"
  enforce_twofactor = true
}
