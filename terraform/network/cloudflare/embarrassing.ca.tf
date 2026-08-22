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

# The apex is the one name in a Spindrift zone that Terraform publishes. Every
# name under it is an App's own record, but the bare zone is a zone-level fact
# — like the tunnel rule that carries it — and so it is declared beside the
# zone. The App that answers here holds the vanity `@` on the Target the record
# points at; Spindrift attaches the domain to the Pages project on deploy
# (`adapters/deploy/pages`) and publishes nothing for it, so this record is the
# whole of the DNS. Serving the apex from a cluster instead is this record
# replaced by a `hostname = "embarrassing.ca"` ingress rule on the Apps tunnel
# in `spindrift.tf`, whose module publishes the CNAME itself.
resource "cloudflare_dns_record" "embarrassing_ca" {
  zone_id = cloudflare_zone.embarrassing_ca.id
  comment = "terraform managed"
  name    = "embarrassing.ca"
  type    = "CNAME"
  content = "embarrassing-perryweb.pages.dev"
  proxied = true
  ttl     = 1
}

# `www` is a redirect to the apex, not a second name the App answers on: an App
# has one vanity name, and a site that answers on two is a site whose links
# point two ways. The record exists only so the edge has something to fire the
# redirect on.
resource "cloudflare_dns_record" "www_embarrassing_ca" {
  zone_id = cloudflare_zone.embarrassing_ca.id
  comment = "terraform managed"
  name    = "www.embarrassing.ca"
  type    = "CNAME"
  content = "embarrassing.ca"
  proxied = true
  ttl     = 1
}

resource "cloudflare_ruleset" "embarrassing_ca_redirects" {
  zone_id     = cloudflare_zone.embarrassing_ca.id
  name        = "redirects"
  description = "www to the apex"
  kind        = "zone"
  phase       = "http_request_dynamic_redirect"

  rules = [
    {
      description = "www.embarrassing.ca to embarrassing.ca"
      expression  = "(http.host eq \"www.embarrassing.ca\")"
      action      = "redirect"
      enabled     = true
      action_parameters = {
        from_value = {
          status_code           = 301
          preserve_query_string = true
          target_url = {
            expression = "concat(\"https://embarrassing.ca\", http.request.uri.path)"
          }
        }
      }
    },
  ]
}
