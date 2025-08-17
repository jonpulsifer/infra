locals {
  wishin_app_zone_settings = {
    always_online            = "on"
    always_use_https         = "on"
    brotli                   = "on"
    http3                    = "on"
    min_tls_version          = "1.2"
    opportunistic_encryption = "on"
    ssl                      = "full"
    tls_1_3                  = "on"
    websockets               = "on"
  }
}

resource "cloudflare_zone" "wishin_app" {
  account = {
    id = local.fml_account_id
  }
  name = "wishin.app"
}

resource "cloudflare_zone_setting" "wishin_app" {
  for_each   = local.wishin_app_zone_settings
  zone_id    = cloudflare_zone.wishin_app.id
  setting_id = each.key
  value      = each.value
}

resource "cloudflare_dns_record" "wishin_app" {
  zone_id = cloudflare_zone.wishin_app.id
  name    = "wishin.app"
  type    = "CNAME"
  content = "cname.vercel-dns.com"
  proxied = true
  ttl     = 1
}

resource "cloudflare_dns_record" "www_wishin_app" {
  zone_id = cloudflare_zone.wishin_app.id
  name    = "www.wishin.app"
  type    = "CNAME"
  content = "wishin.app"
  proxied = true
  ttl     = 1
}
