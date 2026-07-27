# The apex Spindrift mints App names under (spec §9): a zone dedicated to
# generated names, disjoint from the hand-managed flat space in lolwtf.ca.
#
# The zone already exists in the account — this adopts it rather than creating
# it, which is what the `import` block below is for. Its id is looked up by name
# so the adoption does not hardcode an opaque Cloudflare identifier.
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

  # Unlike the other zones in this root, this one was adopted rather than
  # created: its records predate Terraform knowing about it, and Terraform has
  # no plan entry for any of them. Removing this file would therefore destroy a
  # zone whose contents it never managed, which is not a mistake a plan diff
  # would read as alarming.
  lifecycle {
    prevent_destroy = true
  }
}
