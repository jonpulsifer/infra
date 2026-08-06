locals {
  embarrassing_ca_zone_settings = {
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

data "cloudflare_zones" "embarrassing_ca" {
  name = "embarrassing.ca"
}

import {
  to = cloudflare_zone.embarrassing_ca
  id = data.cloudflare_zones.embarrassing_ca.result[0].id
}

resource "cloudflare_zone" "embarrassing_ca" {
  account = {
    id = local.fml_account_id
  }
  name = "embarrassing.ca"
}

resource "cloudflare_zone_dnssec" "embarrassing_ca_dnssec" {
  zone_id = cloudflare_zone.embarrassing_ca.id
  status  = "active"
}

resource "cloudflare_zone_setting" "embarrassing_ca" {
  for_each   = local.embarrassing_ca_zone_settings
  zone_id    = cloudflare_zone.embarrassing_ca.id
  setting_id = each.key
  value      = each.value
}
