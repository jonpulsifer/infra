data "unifi_ap_group" "all_aps" {
  name = "All APs"
}

data "unifi_client_qos_rate" "default" {
  name = "Default"
}

resource "unifi_wlan" "goggly" {
  name          = "Goggly"
  security      = "wpapsk"
  network_id    = unifi_network.default.id
  user_group_id = data.unifi_client_qos_rate.default.id
  ap_group = {
    ids = [data.unifi_ap_group.all_aps.id]
  }

  wlan_band    = "2g"
  wlan_bands   = ["2g"]
  enhanced_iot = true
  wpa3 = {
    support    = false
    transition = false
  }
  pmf_mode             = "disabled"
  group_rekey          = 0
  bss_transition       = false
  fast_roaming_enabled = false
  no2ghz_oui           = false
  # Network 10 ignores this WLAN field; a known value prevents computed drift.
  bandsteering_mode = "off"

  lifecycle {
    ignore_changes = [passphrase]
  }
}

resource "unifi_wlan" "nest" {
  name          = "Nest"
  security      = "wpapsk"
  network_id    = unifi_network.default.id
  user_group_id = data.unifi_client_qos_rate.default.id
  ap_group = {
    ids = [data.unifi_ap_group.all_aps.id]
  }

  wlan_band  = "both"
  wlan_bands = ["2g", "5g", "6g"]
  wpa3 = {
    support    = true
    transition = true
  }
  pmf_mode             = "optional"
  group_rekey          = 0
  bss_transition       = true
  fast_roaming_enabled = false
  no2ghz_oui           = true
  # Network 10 ignores this WLAN field; a known value prevents computed drift.
  bandsteering_mode = "off"

  lifecycle {
    ignore_changes = [passphrase]
  }
}
