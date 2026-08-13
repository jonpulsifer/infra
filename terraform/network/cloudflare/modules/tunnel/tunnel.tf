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

# Routing a hostname and publishing a record for it are two decisions, and a
# wildcard is where they come apart. A wildcard ingress rule is a routing
# catch-all — it is how the tunnel accepts a name some other controller
# published. A wildcard proxied CNAME is a claim over every name in the zone,
# which answers for names nothing serves: the caller authenticates and then
# meets a 404 at the gateway, and a deleted App keeps resolving. Apps publish
# their own records now, so the record half of the wildcard has no work left.
# Several path-scoped ingress rules can share a hostname (Cloudflare routes on
# path within it), so key on the hostname itself and de-dupe with toset rather
# than one record per ingress entry.
resource "cloudflare_dns_record" "cf" {
  for_each = toset([for ingress in var.config.ingress : ingress.hostname if ingress.hostname != null && !startswith(ingress.hostname, "*.")])
  zone_id  = var.zone_id
  comment  = "terraform managed"
  name     = each.value
  content  = "${cloudflare_zero_trust_tunnel_cloudflared.this.id}.cfargotunnel.com"
  type     = "CNAME"
  proxied  = true
  ttl      = 1
}