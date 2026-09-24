# Generated App names only; hand-managed names live in lolwtf.ca.
data "cloudflare_zones" "lolwtf_dev" {
  name = "lolwtf.dev"
}

import {
  to = cloudflare_zone.lolwtf_dev
  id = data.cloudflare_zones.lolwtf_dev.result[0].id
}

resource "cloudflare_zone" "lolwtf_dev" {
  account = {
    id = local.fml_account_id
  }
  name = "lolwtf.dev"

  # Adopted zone: a destroy would take records this root never managed.
  lifecycle {
    prevent_destroy = true
  }
}
