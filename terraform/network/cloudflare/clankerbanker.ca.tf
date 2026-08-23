# A zone Spindrift mints in with `reaches: [public]`, serving a single App at
# the apex (`apps/clankerbanker`). The zone already exists in the account —
# this adopts it rather than creating it, via the `import` block below. The
# registrar is Porkbun; the two steps this root cannot do are at the
# registrar, by hand: point the NS records at `name_servers` below, then
# publish the `ds_record` output so DNSSEC leaves pending.
locals {
  clankerbanker_ca_zone_settings = {
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

data "cloudflare_zones" "clankerbanker_ca" {
  name = "clankerbanker.ca"
}

import {
  to = cloudflare_zone.clankerbanker_ca
  id = data.cloudflare_zones.clankerbanker_ca.result[0].id
}

resource "cloudflare_zone" "clankerbanker_ca" {
  account = {
    id = local.fml_account_id
  }
  name = "clankerbanker.ca"
}

resource "cloudflare_zone_dnssec" "clankerbanker_ca_dnssec" {
  zone_id = cloudflare_zone.clankerbanker_ca.id
  status  = "active"
}

resource "cloudflare_zone_setting" "clankerbanker_ca" {
  for_each   = local.clankerbanker_ca_zone_settings
  zone_id    = cloudflare_zone.clankerbanker_ca.id
  setting_id = each.key
  value      = each.value
}

# The apex record is the App's vanity `@`, published by Spindrift's own
# DNSEndpoint and never written here — see `embarrassing.ca.tf` for why. The
# Apps tunnel carries a `hostname = "clankerbanker.ca"` ingress rule with
# `publish_record = false` (`spindrift.tf`) because cloudflared's `*.<zone>`
# never matches the apex. `www` is a redirect to the apex, not a second name
# the App answers on.
resource "cloudflare_dns_record" "www_clankerbanker_ca" {
  zone_id = cloudflare_zone.clankerbanker_ca.id
  comment = "terraform managed"
  name    = "www.clankerbanker.ca"
  type    = "CNAME"
  content = "clankerbanker.ca"
  proxied = true
  ttl     = 1
}

resource "cloudflare_ruleset" "clankerbanker_ca_redirects" {
  zone_id     = cloudflare_zone.clankerbanker_ca.id
  name        = "redirects"
  description = "www to the apex"
  kind        = "zone"
  phase       = "http_request_dynamic_redirect"

  rules = [
    {
      description = "www.clankerbanker.ca to clankerbanker.ca"
      expression  = "(http.host eq \"www.clankerbanker.ca\")"
      action      = "redirect"
      enabled     = true
      action_parameters = {
        from_value = {
          status_code           = 301
          preserve_query_string = true
          target_url = {
            expression = "concat(\"https://clankerbanker.ca\", http.request.uri.path)"
          }
        }
      }
    },
  ]
}

output "clankerbanker_ca_name_servers" {
  description = "What the registrar's NS records for clankerbanker.ca must be set to."
  value       = cloudflare_zone.clankerbanker_ca.name_servers
}

output "clankerbanker_ca_ds_record" {
  description = "The DS record to publish at the registrar once NS point here."
  value = {
    key_tag     = cloudflare_zone_dnssec.clankerbanker_ca_dnssec.key_tag
    algorithm   = cloudflare_zone_dnssec.clankerbanker_ca_dnssec.algorithm
    digest_type = cloudflare_zone_dnssec.clankerbanker_ca_dnssec.digest_type
    digest      = cloudflare_zone_dnssec.clankerbanker_ca_dnssec.digest
    ds          = cloudflare_zone_dnssec.clankerbanker_ca_dnssec.ds
  }
}
