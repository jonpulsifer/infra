resource "cloudflare_zero_trust_tunnel_cloudflared" "this" {
  account_id = var.account_id
  name       = var.name
  config_src = "cloudflare"
}

data "cloudflare_zero_trust_tunnel_cloudflared_token" "this" {
  account_id = var.account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.this.id
}

resource "cloudflare_zero_trust_tunnel_cloudflared_config" "this" {
  account_id = var.account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.this.id
  config     = var.config
}

# No record for a wildcard rule: a wildcard CNAME answers for names nothing serves.
# Path-scoped rules can share a hostname, so toset keeps one record per name.
resource "cloudflare_dns_record" "cf" {
  for_each = toset([for ingress in var.config.ingress : ingress.hostname if ingress.hostname != null && !startswith(ingress.hostname, "*.") && ingress.publish_record])
  zone_id  = var.zone_id
  comment  = "terraform managed"
  name     = each.value
  content  = "${cloudflare_zero_trust_tunnel_cloudflared.this.id}.cfargotunnel.com"
  type     = "CNAME"
  proxied  = true
  ttl      = 1
}