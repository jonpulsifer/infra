# A zone Spindrift mints App names in with `reaches: [public]`. The zone
# already exists in the account — this adopts it rather than creating it, via
# the `import` block below. Its id is looked up by name so the adoption does
# not hardcode an opaque Cloudflare identifier.
locals {
  kthx_dev_zone_settings = {
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

  # Adopted rather than created: its records predate Terraform knowing about
  # the zone, and Terraform has no plan entry for any of them. Removing this
  # file would destroy a zone whose contents it never managed.
  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_zone_setting" "kthx_dev" {
  for_each   = local.kthx_dev_zone_settings
  zone_id    = cloudflare_zone.kthx_dev.id
  setting_id = each.key
  value      = each.value
}
