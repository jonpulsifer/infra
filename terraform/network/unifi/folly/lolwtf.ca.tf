locals {
  lab_cidr    = "10.2.0.1/24"
  lab_domain  = "lolwtf.ca"
  lab_wlan    = "lab"
  lab_clients = merge(local.clients.lab, local.clients.rpis)
}

data "cloudflare_zone" "lab" {
  filter = {
    name   = local.lab_domain
    status = "active"
  }
}

resource "cloudflare_dns_record" "lab_remote_dns" {
  for_each = {
    for name, client in local.lab_clients : name => client
    if can(client.ip == true)
  }
  zone_id = data.cloudflare_zone.lab.zone_id
  name    = "${each.key}.${local.lab_domain}"
  content = cidrhost(local.lab_cidr, each.value.ip)
  type    = "A"
  ttl     = 1
  comment = "terraform managed"
  proxied = false
  # tags    = ["terraform-managed"]
}

resource "unifi_network" "lab" {
  name               = "Lab Net"
  subnet             = local.lab_cidr
  vlan               = 2
  domain_name        = local.lab_domain
  setting_preference = "manual"
  auto_scale         = false
  lte_lan            = false
  network_isolation  = true
  multicast_dns      = false

  dhcp_server = {
    enabled   = true
    leasetime = local.one_week
    start     = cidrhost(local.lab_cidr, 200)
    stop      = cidrhost(local.lab_cidr, 254)
    boot = {
      enabled = false
    }
  }

}

resource "unifi_wlan" "lab" {
  name                      = local.lab_wlan
  security                  = "open"
  hide_ssid                 = true
  ap_group_ids              = ["693c98563a6bcc1ba862e1ae"]
  ap_group_mode             = "devices"
  network_id                = unifi_network.lab.id
  user_group_id             = unifi_client_qos_rate.unmetered.id
  multicast_enhance         = false
  bss_transition            = false
  no2ghz_oui                = false
  uapsd                     = true
  wlan_band                 = "both"
  wlan_bands                = ["2g", "5g"]
  minimum_data_rate_2g_kbps = 1000
  minimum_data_rate_5g_kbps = 6000

  lifecycle {
    ignore_changes = [passphrase]
  }
}
