locals {
  lab_cidr    = "10.2.0.0/24"
  lab_domain  = "lolwtf.ca"
  lab_wlan    = "lab"
  lab_clients = merge(local.clients.lab, local.clients.rpis)
}

data "unifi_ap_group" "lab" {
  name = "Lab"
}

data "cloudflare_zone" "lab" {
  name = local.lab_domain
}

resource "cloudflare_record" "lab_remote_dns" {
  for_each = {
    for name, client in local.lab_clients : name => client
    if can(client.ip == true)
  }
  zone_id   = data.cloudflare_zone.lab.id
  name      = each.key
  content   = cidrhost(local.lab_cidr, each.value.ip)
  type      = "A"
  ttl       = 1
  comment   = "terraform managed"
  # tags    = ["terraform-managed"]
}

resource "unifi_network" "lab" {
  name          = "Lab Net"
  domain_name   = local.lab_domain
  network_group = "LAN"
  purpose       = "corporate"
  subnet        = local.lab_cidr
  vlan_id       = 2

  dhcp_enabled  = true
  dhcp_lease    = local.one_week
  dhcp_start    = cidrhost(local.lab_cidr, 200)
  dhcp_stop     = cidrhost(local.lab_cidr, 254)
  multicast_dns = false
  igmp_snooping = false
}

resource "unifi_wlan" "lab" {
  name              = local.lab_wlan
  security          = "open"
  hide_ssid         = true
  ap_group_ids      = [data.unifi_ap_group.lab.id]
  network_id        = unifi_network.lab.id
  user_group_id     = unifi_user_group.unmetered.id
  multicast_enhance = true
  bss_transition    = false
  wlan_band         = "both"
}

resource "unifi_user" "lab" {
  for_each               = local.lab_clients
  name                   = each.key
  mac                    = each.value.mac
  local_dns_record       = lookup(each.value, "ip", false) == false ? null : can(regex("^[a-zA-Z0-9]+[a-zA-Z0-9-]*[^-]$", lookup(each.value, "local_dns_record", each.key))) == false ? "" : format("%s.%s", lower(lookup(each.value, "local_dns_record", each.key)), local.lab_domain)
  fixed_ip               = lookup(each.value, "ip", false) == false ? null : cidrhost(local.lab_cidr, each.value.ip)
  blocked                = lookup(each.value, "blocked", false)
  note                   = lookup(each.value, "note", "Managed by terraform")
  allow_existing         = lookup(each.value, "allow_existing", true)
  skip_forget_on_destroy = lookup(each.value, "skip_forget_on_destroy", true)
  dev_id_override        = lookup(each.value, "dev-id", 0)
  network_id             = unifi_network.lab.id
  user_group_id          = unifi_user_group.unmetered.id
}
