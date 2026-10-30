resource "unifi_wan" "internet_1" {
  name               = "Internet 1"
  enabled            = false
  type               = "dhcp"
  type_v6            = "disabled"
  setting_preference = "manual"

  dns = {
    preference = "manual"
    primary    = "1.1.1.1"
    secondary  = "8.8.8.8"
  }

  load_balance = {
    type   = "weighted"
    weight = 50
  }

  # Provider 0.60 reads dns.ipv6 back as unknown and then PUTs a payload
  # this controller rejects (api.err.InvalidPayload), so the block stays
  # out of the diff.
  lifecycle {
    ignore_changes = [dns.ipv6]
  }
}

resource "unifi_wan" "internet_2" {
  name               = "Internet 2"
  enabled            = false
  type               = "dhcp"
  type_v6            = "disabled"
  setting_preference = "auto"

  load_balance = {
    type = "failover-only"
  }
}
