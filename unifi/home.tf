locals {
  fml_cidr   = "10.1.0.1/24"
  fml_domain = "fml.pulsifer.ca"
  fml_wlan   = "fml"
  clients    = yamldecode(file("./clients.yaml"))
  one_day    = 86400
  one_week   = local.one_day * 7
}

resource "unifi_network" "fml" {
  name   = "Management"
  subnet = local.fml_cidr

  dhcp_server = {
    enabled   = true
    leasetime = local.one_day
    start     = cidrhost(local.fml_cidr, 100)
    stop      = cidrhost(local.fml_cidr, 254)
    boot = {
      enabled = false
    }
  }

  dhcp_relay = {
    enabled = false
  }
}


data "unifi_ap_group" "all_aps" {
  name = "All APs"
}

data "vault_generic_secret" "wifi" {
  path = "home/wifi"
}

resource "unifi_wlan" "fml" {
  name       = local.fml_wlan
  security   = "wpapsk"
  passphrase = data.vault_generic_secret.wifi.data[local.fml_wlan]

  ap_group_ids = [
    data.unifi_ap_group.all_aps.id,
  ]

  network_id    = unifi_network.fml.id
  user_group_id = unifi_client_qos_rate.unmetered.id

  wlan_band            = "both"
  bss_transition       = true
  fast_roaming_enabled = false
  multicast_enhance    = false
  uapsd                = true
  no2ghz_oui           = false
}

resource "unifi_client" "personal_devices" {
  for_each               = local.clients.personal-devices
  name                   = each.key
  mac                    = each.value.mac
  local_dns_record       = lookup(each.value, "ip", false) == false ? null : can(regex("^[a-zA-Z0-9]+[a-zA-Z0-9-]*[^-]$", lookup(each.value, "local_dns_record", each.key))) == false ? "" : format("%s.%s", lower(lookup(each.value, "local_dns_record", each.key)), local.fml_domain)
  blocked                = lookup(each.value, "blocked", false)
  fixed_ip               = lookup(each.value, "ip", false) == false ? null : cidrhost(local.fml_cidr, each.value.ip)
  note                   = lookup(each.value, "note", "Managed by terraform")
  allow_existing         = lookup(each.value, "allow_existing", true)
  skip_forget_on_destroy = lookup(each.value, "skip_forget_on_destroy", true)
  network_id             = unifi_network.fml.id
  qos_rate = {
    id = unifi_client_qos_rate.unmetered.id
  }
}

resource "unifi_client" "computers" {
  for_each               = merge(local.clients.desktops, local.clients.laptops)
  name                   = each.key
  mac                    = each.value.mac
  local_dns_record       = lookup(each.value, "ip", false) == false ? null : can(regex("^[a-zA-Z0-9]+[a-zA-Z0-9-]*[^-]$", lookup(each.value, "local_dns_record", each.key))) == false ? "" : format("%s.%s", lower(lookup(each.value, "local_dns_record", each.key)), local.fml_domain)
  blocked                = lookup(each.value, "blocked", false)
  fixed_ip               = lookup(each.value, "ip", false) == false ? null : cidrhost(local.fml_cidr, each.value.ip)
  note                   = lookup(each.value, "note", "Managed by terraform")
  allow_existing         = lookup(each.value, "allow_existing", true)
  skip_forget_on_destroy = lookup(each.value, "skip_forget_on_destroy", true)
  network_id             = unifi_network.fml.id
  qos_rate = {
    id = unifi_client_qos_rate.unmetered.id
  }
}

resource "unifi_client" "iot" {
  for_each               = local.clients.iot
  name                   = each.key
  mac                    = each.value.mac
  local_dns_record       = lookup(each.value, "ip", false) == false ? null : can(regex("^[a-zA-Z0-9]+[a-zA-Z0-9-]*[^-]$", lookup(each.value, "local_dns_record", each.key))) == false ? "" : format("%s.%s", lower(lookup(each.value, "local_dns_record", each.key)), local.fml_domain)
  blocked                = lookup(each.value, "blocked", false)
  fixed_ip               = lookup(each.value, "ip", false) == false ? null : cidrhost(local.fml_cidr, each.value.ip)
  note                   = lookup(each.value, "note", "Managed by terraform")
  allow_existing         = lookup(each.value, "allow_existing", true)
  skip_forget_on_destroy = lookup(each.value, "skip_forget_on_destroy", true)
  network_id             = unifi_network.fml.id
  qos_rate = {
    id = lookup(each.value, "streaming", false) == false ? unifi_client_qos_rate.iot.id : unifi_client_qos_rate.streaming.id
  }
}

resource "unifi_client" "cameras" {
  for_each               = local.clients.cameras
  name                   = each.key
  mac                    = each.value.mac
  local_dns_record       = lookup(each.value, "ip", false) == false ? "" : can(regex("^[a-zA-Z0-9]+[a-zA-Z0-9-]*[^-]$", lookup(each.value, "local_dns_record", each.key))) == false ? "" : format("%s.%s", lower(lookup(each.value, "local_dns_record", each.key)), local.fml_domain)
  fixed_ip               = lookup(each.value, "ip", false) == false ? null : cidrhost(local.fml_cidr, each.value.ip)
  blocked                = lookup(each.value, "blocked", false)
  note                   = lookup(each.value, "note", "Managed by terraform")
  allow_existing         = lookup(each.value, "allow_existing", true)
  skip_forget_on_destroy = lookup(each.value, "skip_forget_on_destroy", true)
  network_id             = unifi_network.fml.id
  qos_rate = {
    id = unifi_client_qos_rate.unmetered.id
  }
}