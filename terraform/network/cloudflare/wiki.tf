# .github/workflows/wiki.yml builds docs/ and uploads it with `wrangler pages deploy`,
# using the CLOUDFLARE_API_TOKEN Actions secret scoped to Pages:Edit.
resource "cloudflare_pages_project" "wiki" {
  account_id        = local.fml_account_id
  name              = "infra-wiki"
  production_branch = "main"
}

resource "cloudflare_pages_domain" "wiki" {
  account_id   = local.fml_account_id
  project_name = cloudflare_pages_project.wiki.name
  name         = "wiki.${cloudflare_zone.lolwtf_ca.name}"
}

resource "cloudflare_dns_record" "wiki_lolwtf_ca" {
  zone_id = cloudflare_zone.lolwtf_ca.id
  name    = "wiki.lolwtf.ca"
  type    = "CNAME"
  content = cloudflare_pages_project.wiki.subdomain
  proxied = true
  ttl     = 1
}
