locals {
  lab_tunnel_id  = "50084153-52c2-491f-8b29-450defeb85bc"
  lab_tunnel_url = "${local.lab_tunnel_id}.cfargotunnel.com"
}

resource "cloudflare_zone" "lolwtf_ca" {
  account = {
    id = local.fml_account_id
  }
  name = "lolwtf.ca"
}

module "tunnel_folly" {
  source     = "./modules/tunnel"
  account_id = local.fml_account_id
  zone_id    = cloudflare_zone.lolwtf_ca.id
  name       = "folly"
  config = {
    ingress = [
      {
        service = "http_status:418"
      }
    ]
  }
}

module "tunnel_offsite" {
  source     = "./modules/tunnel"
  account_id = local.fml_account_id
  zone_id    = cloudflare_zone.lolwtf_ca.id
  name       = "offsite"
  config = {
    ingress = [
      {
        hostname = "offsite.${cloudflare_zone.lolwtf_ca.name}"
        service  = "http_status:418"
      },
      {
        hostname = "tf.${cloudflare_zone.lolwtf_ca.name}"
        service  = "http://atlantis.atlantis"
      },
      {
        service = "http_status:418"
      }
    ]
  }
}

output "cloudflare_tunnel_token_folly" {
  sensitive = true
  value     = module.tunnel_folly.cloudflare_tunnel_token
}

output "cloudflare_tunnel_token_offsite" {
  sensitive = true
  value     = module.tunnel_offsite.cloudflare_tunnel_token
}