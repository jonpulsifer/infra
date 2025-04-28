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

resource "cloudflare_dns_record" "cf" {
  zone_id = cloudflare_zone.lolwtf_ca.id
  comment = "terraform managed"
  name    = "cf.${cloudflare_zone.lolwtf_ca.name}"
  content = local.lab_tunnel_url
  type    = "CNAME"
  proxied = true
  ttl     = 1
}

resource "cloudflare_dns_record" "cf2" {
  zone_id = cloudflare_zone.lolwtf_ca.id
  comment = "terraform managed"
  name    = "cf2.${cloudflare_zone.lolwtf_ca.name}"
  content = local.lab_tunnel_url
  type    = "CNAME"
  proxied = true
  ttl     = 1
}

resource "cloudflare_dns_record" "cf3" {
  zone_id = cloudflare_zone.lolwtf_ca.id
  comment = "terraform managed"
  name    = "cf3.${cloudflare_zone.lolwtf_ca.name}"
  content = local.lab_tunnel_url
  type    = "CNAME"
  proxied = true
  ttl     = 1
}

resource "cloudflare_dns_record" "db" {
  zone_id = cloudflare_zone.lolwtf_ca.id
  comment = "terraform managed"
  name    = "db.${cloudflare_zone.lolwtf_ca.name}"
  content = local.lab_tunnel_url
  type    = "CNAME"
  proxied = true
  ttl     = 1
}
