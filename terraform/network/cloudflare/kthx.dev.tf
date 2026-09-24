# Quick static sites: the apex is the landing page and each `<name>.kthx.dev` is a site.
# At the registrar, by hand: set NS to the name_servers output, then publish ds_record.

# always_online is off: the Internet Archive has never crawled these names.
# browser_cache_ttl 0 respects origin headers; the 4h default overrides max-age.
locals {
  kthx_dev_zone_settings = {
    always_online            = "off"
    always_use_https         = "on"
    browser_cache_ttl        = 0
    brotli                   = "on"
    http3                    = "on"
    min_tls_version          = "1.2"
    opportunistic_encryption = "on"
    ssl                      = "full"
    tls_1_3                  = "on"
    websockets               = "on"
  }
}

data "cloudflare_zones" "kthx_dev" {
  name = "kthx.dev"
}

import {
  to = cloudflare_zone.kthx_dev
  id = data.cloudflare_zones.kthx_dev.result[0].id
}

resource "cloudflare_zone" "kthx_dev" {
  account = {
    id = local.fml_account_id
  }
  name = "kthx.dev"

  # Adopted zone: a destroy would take records this root never managed.
  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_zone_dnssec" "kthx_dev_dnssec" {
  zone_id = cloudflare_zone.kthx_dev.id
  status  = "active"
}

resource "cloudflare_zone_setting" "kthx_dev" {
  for_each   = local.kthx_dev_zone_settings
  zone_id    = cloudflare_zone.kthx_dev.id
  setting_id = each.key
  value      = each.value
}

# The apex and wildcard records are kthx_apex and kthx_sites_wildcard in
# spindrift.tf. www only redirects to the apex.
resource "cloudflare_dns_record" "www_kthx_dev" {
  zone_id = cloudflare_zone.kthx_dev.id
  comment = "terraform managed"
  name    = "www.kthx.dev"
  type    = "CNAME"
  content = "kthx.dev"
  proxied = true
  ttl     = 1
}

# Cloudflare never caches HTML by default. Rules stack and the last match wins
# per setting, so the bypass rule goes last and must exempt the SDK.
resource "cloudflare_ruleset" "kthx_dev_cache" {
  zone_id     = cloudflare_zone.kthx_dev.id
  name        = "cache"
  description = "sites cache on the origin's terms; the data plane never does"
  kind        = "zone"
  phase       = "http_request_cache_settings"

  rules = [
    {
      description = "sites cache on the origin's terms"
      expression  = "(ends_with(http.host, \"kthx.dev\"))"
      action      = "set_cache_settings"
      enabled     = true
      action_parameters = {
        cache                = true
        respect_strong_etags = true
        edge_ttl = {
          mode = "respect_origin"
        }
        browser_ttl = {
          mode = "respect_origin"
        }
        serve_stale = {
          disable_stale_while_updating = false
        }
      }
    },
    # Bare /api is spelled out: starts_with "/api" also matches "/apifoo".
    # /kthx/ is the retired v1 API path; the server answers it with 410.
    {
      description = "the data plane and the API are never cached; the SDK is not data"
      expression  = "((http.request.uri.path eq \"/api\" or starts_with(http.request.uri.path, \"/api/\")) and http.request.uri.path ne \"/api/sdk.js\") or starts_with(http.request.uri.path, \"/files/\") or (starts_with(http.request.uri.path, \"/_/\") and http.request.uri.path ne \"/_/sdk.js\") or (http.host eq \"kthx.dev\" and starts_with(http.request.uri.path, \"/kthx/\"))"
      action      = "set_cache_settings"
      enabled     = true
      action_parameters = {
        cache = false
      }
    },
  ]
}

resource "cloudflare_ruleset" "kthx_dev_redirects" {
  zone_id     = cloudflare_zone.kthx_dev.id
  name        = "redirects"
  description = "www to the apex"
  kind        = "zone"
  phase       = "http_request_dynamic_redirect"

  rules = [
    {
      description = "www.kthx.dev to kthx.dev"
      expression  = "(http.host eq \"www.kthx.dev\")"
      action      = "redirect"
      enabled     = true
      action_parameters = {
        from_value = {
          status_code           = 301
          preserve_query_string = true
          target_url = {
            expression = "concat(\"https://kthx.dev\", http.request.uri.path)"
          }
        }
      }
    },
  ]
}

output "kthx_dev_name_servers" {
  description = "What the registrar's NS records for kthx.dev must be set to."
  value       = cloudflare_zone.kthx_dev.name_servers
}

output "kthx_dev_ds_record" {
  description = "The DS record to publish at the registrar once NS point here."
  value = {
    key_tag     = cloudflare_zone_dnssec.kthx_dev_dnssec.key_tag
    algorithm   = cloudflare_zone_dnssec.kthx_dev_dnssec.algorithm
    digest_type = cloudflare_zone_dnssec.kthx_dev_dnssec.digest_type
    digest      = cloudflare_zone_dnssec.kthx_dev_dnssec.digest
    ds          = cloudflare_zone_dnssec.kthx_dev_dnssec.ds
  }
}
