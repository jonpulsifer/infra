resource "cloudflare_zone" "pulsifer_ca" {
  account_id = cloudflare_account.fml.id
  zone       = "pulsifer.ca"
}

resource "cloudflare_zone_settings_override" "pulsifer_ca" {
  zone_id = cloudflare_zone.pulsifer_ca.id
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

resource "cloudflare_record" "www_pulsifer_ca" {
  zone_id = cloudflare_zone.pulsifer_ca.id
  name    = "www.pulsifer.ca"
  type    = "CNAME"
  value   = "pulsifer.ca"
  proxied = true
}

# pulsifer.ca gmail mx records
resource "cloudflare_record" "mx_pulsifer_ca" {
  for_each = {
    1 : { record : "aspmx.l.google.com", pri : 1 },
    2 : { record : "alt1.aspmx.l.google.com", pri : 5 },
    3 : { record : "alt2.aspmx.l.google.com", pri : 5 },
    4 : { record : "alt3.aspmx.l.google.com", pri : 10 },
    5 : { record : "alt4.aspmx.l.google.com", pri : 10 },
  }
  zone_id  = cloudflare_zone.pulsifer_ca.id
  name     = "pulsifer.ca"
  type     = "MX"
  priority = each.value.pri
  value    = each.value.record
  proxied  = false
}

resource "cloudflare_record" "pulsifer_ca" {
  for_each = toset([
    "185.199.108.153",
    "185.199.109.153",
    "185.199.110.153",
    "185.199.111.153",
  ])
  zone_id = cloudflare_zone.pulsifer_ca.id
  name    = "pulsifer.ca"
  type    = "A"
  value   = each.value
  proxied = true
}

resource "cloudflare_record" "bbq_pulsifer_ca" {
  zone_id = cloudflare_zone.pulsifer_ca.id
  name    = "bbq.pulsifer.ca"
  type    = "A"
  value   = "192.168.1.126"
  proxied = false
}
