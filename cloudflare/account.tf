locals {
  fml_account_id = "d7f641bb9f4b9de593f721ad06989dbe"
}

data "cloudflare_account" "fml" {
  account_id = local.fml_account_id
}

resource "cloudflare_list" "github_webhook_addresses" {
  account_id  = local.fml_account_id
  name        = "github_webhook_ips"
  kind        = "ip"
  description = "GitHub webhook addresses"
  # https://api.github.com/meta
  items = [
    {
      ip = "192.30.252.0/22"
    },
    {
      ip = "185.199.108.0/22"
    },
    {
      ip = "140.82.112.0/20"
    },
    {
      ip = "143.55.64.0/20"
    },
    {
      ip = "2a0a:a440::/29"
    },
    {
      ip = "2606:50c0::/32"
    }
  ]
}