resource "cloudflare_zone" "wishin_app" {
  account_id = cloudflare_account.fml.id
  zone       = "wishin.app"
}

resource "cloudflare_zone_settings_override" "wishin_app" {
  zone_id = cloudflare_zone.wishin_app.id
  settings {
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

resource "cloudflare_record" "wishin_app" {
  zone_id = cloudflare_zone.wishin_app.id
  name    = "wishin.app"
  type    = "CNAME"
  value   = "cname.vercel-dns.com"
  proxied = true
}

resource "cloudflare_record" "www_wishin_app" {
  zone_id = cloudflare_zone.wishin_app.id
  name    = "www.wishin.app"
  type    = "CNAME"
  value   = "wishin.app"
  proxied = true
}
