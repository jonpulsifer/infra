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
        hostname = "tf.${cloudflare_zone.lolwtf_ca.name}"
        service  = "http://atlantis.atlantis"
      },
      {
        service = "http_status:418"
      }
    ]
  }
}

resource "cloudflare_dns_record" "folly_lolwtf_ca" {
  zone_id = cloudflare_zone.lolwtf_ca.id
  name    = "folly.lolwtf.ca"
  type    = "A"
  content = local.topology.folly.API_SERVER_IP
  proxied = false
  ttl     = 1
}

resource "cloudflare_dns_record" "offsite_lolwtf_ca" {
  zone_id = cloudflare_zone.lolwtf_ca.id
  name    = "offsite.lolwtf.ca"
  type    = "A"
  content = local.topology.offsite.API_SERVER_IP
  proxied = false
  ttl     = 1
}

# offsite's nodes, by hostname. folly's are next to their DHCP reservations in
# terraform/network/unifi/folly/k8s.tf, from the same topology key.
resource "cloudflare_dns_record" "offsite_nodes" {
  for_each = jsondecode(local.topology.offsite.NODE_ADDRESSES)

  zone_id = cloudflare_zone.lolwtf_ca.id
  name    = "${each.key}.${cloudflare_zone.lolwtf_ca.name}"
  type    = "A"
  content = each.value
  proxied = false
  ttl     = 1
}

# Both records exist, made by hand before this root declared them. The first
# apply adopts them; a later PR removes these blocks.
import {
  to = cloudflare_dns_record.offsite_nodes["retrofit"]
  id = "6db37c857d0c3631bea427fab3301e89/38c602ba200d92710d0b8d86cf84654f"
}

import {
  to = cloudflare_dns_record.offsite_nodes["oldschool"]
  id = "6db37c857d0c3631bea427fab3301e89/b4c2f68960aca083a7a4f0a2305ee740"
}

output "cloudflare_tunnel_token_folly" {
  sensitive = true
  value     = module.tunnel_folly.cloudflare_tunnel_token
}

output "cloudflare_tunnel_token_offsite" {
  sensitive = true
  value     = module.tunnel_offsite.cloudflare_tunnel_token
}
