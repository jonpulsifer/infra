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

  retired_ips = ["192.30.252.153/32", "192.30.252.154/32"]
  github_pages_ip_addresses = toset(
    [for ip in setsubtract(data.github_ip_ranges.this.pages_ipv4, local.retired_ips) : cidrhost(ip, 0)]
  )
}

resource "cloudflare_zone" "pulsifer_ca" {
  account = {
    id = local.fml_account_id
  }
  name = "pulsifer.ca"
}

resource "cloudflare_zone_dnssec" "pulsifer_ca_dnssec" {
  zone_id = cloudflare_zone.pulsifer_ca.id
}

resource "cloudflare_zone_setting" "pulsifer_ca" {
  for_each   = local.pulsifer_ca_zone_settings
  zone_id    = cloudflare_zone.pulsifer_ca.id
  setting_id = each.key
  value      = each.value
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
  zone_id  = cloudflare_zone.pulsifer_ca.id
  name     = "pulsifer.ca"
  type     = "MX"
  priority = 1
  content  = "smtp.google.com"
  proxied  = false
  ttl      = 1
  lifecycle {
    create_before_destroy = true
  }
}

data "github_ip_ranges" "this" {}

resource "cloudflare_dns_record" "pulsifer_ca" {
  for_each = local.github_pages_ip_addresses
  zone_id  = cloudflare_zone.pulsifer_ca.id
  name     = "pulsifer.ca"
  type     = "A"
  content  = each.value
  proxied  = true
  ttl      = 1
}

resource "cloudflare_dns_record" "bbq_pulsifer_ca" {
  zone_id = cloudflare_zone.pulsifer_ca.id
  name    = "bbq.pulsifer.ca"
  type    = "A"
  content = "192.168.1.126"
  proxied = false
  ttl     = 1
}

# https://bitcoin.design/guide/how-it-works/human-readable-addresses/
resource "cloudflare_dns_record" "bitcoin" {
  zone_id = cloudflare_zone.pulsifer_ca.id
  name    = "jonathan.user._bitcoin-payment"
  type    = "TXT"
  content = "bitcoin:?lno=lno1zrxq8pjw7qjlm68mtp7e3yvxee4y5xrgjhhyf2fxhlphpckrvevh50u0q0fnc6rxvsxxkuk5ma9t8qawsslczavv5vdvh7rma8qytrvkk74yjqsrl2sm2klx5m89x4qqu4a74u6v3hfcz08nemr6hej6peqdl9cw0n0qqvetwtvs8lhqg4guqf7tdagun79a9efuz5wm239ca2qgedfuw834pv78ymgjeln6cwz0su8t2tj8lklamk0aq023rutda0csuawd90zg26jxmlyu6p3j0swr87rv76fhkj854axe2qqsy5ntn3aleexd4pxhdysvdjjjxv"
  proxied = false
  ttl     = 1
}
