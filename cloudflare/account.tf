locals {
  fml_account_id = "d7f641bb9f4b9de593f721ad06989dbe"
}

data "cloudflare_account" "fml" {
  account_id = local.fml_account_id
}
