resource "cloudflare_zone" "lolwtf_ca" {
  account_id = cloudflare_account.fml.id
  zone       = "lolwtf.ca"
}
