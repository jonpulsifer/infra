locals {
  lab_tunnel_id  = "50084153-52c2-491f-8b29-450defeb85bc"
  lab_tunnel_url = "${local.lab_tunnel_id}.cfargotunnel.com"
}

resource "cloudflare_zone" "lolwtf_ca" {
  account = {
    id = local.fml_account_id
  }
  name = "lolwtf.ca"
}

resource "cloudflare_zero_trust_tunnel_cloudflared" "folly" {
  account_id = local.fml_account_id
  name = "Folly"
  config_src = "local"
}

data "cloudflare_zero_trust_tunnel_cloudflared_token" "folly" {
  account_id = local.fml_account_id
  tunnel_id = cloudflare_zero_trust_tunnel_cloudflared.folly.id
}

output "cloudflare_tunnel_token" {
  value = data.cloudflare_zero_trust_tunnel_cloudflared_token.folly.token
}

resource "cloudflare_dns_record" "cf" {
  zone_id = cloudflare_zone.lolwtf_ca.id
  comment = "terraform managed"
  name    = "cf.folly.${cloudflare_zone.lolwtf_ca.name}"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.folly.id}.cfargotunnel.com"
  type    = "CNAME"
  proxied = true
  ttl     = 1
}