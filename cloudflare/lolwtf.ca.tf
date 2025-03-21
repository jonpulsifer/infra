locals {
  lab_tunnel_id  = "50084153-52c2-491f-8b29-450defeb85bc"
  lab_tunnel_url = "${local.lab_tunnel_id}.cfargotunnel.com"
}

resource "cloudflare_zone" "lolwtf_ca" {
  account_id = cloudflare_account.fml.id
  zone       = "lolwtf.ca"
}

resource "cloudflare_record" "cf" {
  zone_id = cloudflare_zone.lolwtf_ca.id
  comment = "terraform managed"
  name    = "cf"
  value   = local.lab_tunnel_url
  type    = "CNAME"
  proxied = true
  ttl     = 1
}


resource "cloudflare_record" "cf2" {
  zone_id = cloudflare_zone.lolwtf_ca.id
  comment = "terraform managed"
  name    = "cf2"
  value   = local.lab_tunnel_url
  type    = "CNAME"
  proxied = true
  ttl     = 1
}


resource "cloudflare_record" "cf3" {
  zone_id = cloudflare_zone.lolwtf_ca.id
  comment = "terraform managed"
  name    = "cf3"
  value   = local.lab_tunnel_url
  type    = "CNAME"
  proxied = true
  ttl     = 1
}


resource "cloudflare_record" "db" {
  zone_id = cloudflare_zone.lolwtf_ca.id
  comment = "terraform managed"
  name    = "db"
  value   = local.lab_tunnel_url
  type    = "CNAME"
  proxied = true
  ttl     = 1
}
