# Serves the cluster OIDC documents and JWKS that .github/workflows/oidc.yml uploads.
# The hostname is every cluster's SA token issuer and GCP workload identity pins it:
# renaming it needs a full issuer migration.
resource "cloudflare_pages_project" "oidc" {
  account_id        = local.fml_account_id
  name              = "fml-oidc"
  production_branch = "main"
}

resource "cloudflare_pages_domain" "oidc" {
  account_id   = local.fml_account_id
  project_name = cloudflare_pages_project.oidc.name
  name         = "oidc.${cloudflare_zone.lolwtf_ca.name}"
}

resource "cloudflare_dns_record" "oidc_lolwtf_ca" {
  zone_id = cloudflare_zone.lolwtf_ca.id
  name    = "oidc.lolwtf.ca"
  type    = "CNAME"
  content = cloudflare_pages_project.oidc.subdomain
  proxied = true
  ttl     = 1
}
