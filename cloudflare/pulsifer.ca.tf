locals {
  pulsifer_ca_zone_settings = {
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

resource "cloudflare_zone" "pulsifer_ca" {
  account = {
    id = local.fml_account_id
  }
  name = "pulsifer.ca"
}

resource "cloudflare_zone_setting" "pulsifer_ca" {
  for_each   = local.pulsifer_ca_zone_settings
  zone_id    = cloudflare_zone.pulsifer_ca.id
  setting_id = each.key
  value      = each.value
  id         = each.key
}

resource "cloudflare_dns_record" "www_pulsifer_ca" {
  zone_id = cloudflare_zone.pulsifer_ca.id
  name    = "www.pulsifer.ca"
  type    = "CNAME"
  content = "pulsifer.ca"
  proxied = true
  ttl     = 1
}

# pulsifer.ca gmail mx records
resource "cloudflare_dns_record" "mx_pulsifer_ca" {
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
  content  = each.value.record
  proxied  = false
  ttl      = 1
}

resource "cloudflare_dns_record" "pulsifer_ca" {
  for_each = toset([
    "185.199.108.153",
    "185.199.109.153",
    "185.199.110.153",
    "185.199.111.153",
  ])
  zone_id = cloudflare_zone.pulsifer_ca.id
  name    = "pulsifer.ca"
  type    = "A"
  content = each.value
  proxied = true
  ttl     = 1
}

resource "cloudflare_dns_record" "bbq_pulsifer_ca" {
  zone_id = cloudflare_zone.pulsifer_ca.id
  name    = "bbq.pulsifer.ca"
  type    = "A"
  content = "192.168.1.126"
  proxied = false
  ttl     = 1
}
