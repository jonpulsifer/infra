locals {
  fml_cidr    = "10.1.0.1/24"
  fml_domain  = "fml.pulsifer.ca"
  fml_wlan    = "fml"
  future_cidr = "10.13.37.1/28"
  iot_cidr    = "10.66.6.1/26"
  iot_domain  = "iot.fml.pulsifer.ca"
  clients     = yamldecode(file("./clients.yaml"))
  one_day     = "24h0m0s"
  one_week    = "168h0m0s"
}

resource "unifi_network" "fml" {
  name               = "Management"
  subnet             = local.fml_cidr
  domain_name        = local.fml_domain
  setting_preference = "manual"
  auto_scale         = false
  lte_lan            = false
  multicast_dns      = true

  dhcp_server = {
    enabled   = true
    leasetime = local.one_day
    start     = cidrhost(local.fml_cidr, 100)
    stop      = cidrhost(local.fml_cidr, 254)
    boot = {
      enabled = false
    }
  }

}


data "unifi_ap_group" "all_aps" {
  name = "All APs"
}

data "onepassword_item" "wifi" {
  vault = local.vault_id
  uuid  = "a2etujelxm3zqseawe3phxtyc4"
}

resource "unifi_wlan" "fml" {
  name       = local.fml_wlan
  security   = "wpapsk"
  passphrase = data.onepassword_item.wifi.password

  ap_group_ids = [
    data.unifi_ap_group.all_aps.id,
  ]

  network_id    = unifi_network.fml.id
  user_group_id = unifi_client_qos_rate.unmetered.id

  wlan_band                 = "both"
  wlan_bands                = ["2g", "5g", "6g"]
  wpa3_support              = true
  wpa3_transition           = true
  pmf_mode                  = "optional"
  minimum_data_rate_2g_kbps = 1000
  minimum_data_rate_5g_kbps = 6000
  bss_transition            = true
  fast_roaming_enabled      = false
  multicast_enhance         = false
  uapsd                     = true
  no2ghz_oui                = false
}
