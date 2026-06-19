resource "unifi_client_qos_rate" "unmetered" {
  name              = "Unlimited Power"
  qos_rate_max_down = 100000
  qos_rate_max_up   = 100000
}

resource "unifi_client_qos_rate" "iot" {
  name              = "IoT"
  qos_rate_max_down = 100000
  qos_rate_max_up   = 100000
}

resource "unifi_client_qos_rate" "streaming" {
  name              = "Streaming Media"
  qos_rate_max_down = 100000
  qos_rate_max_up   = 100000
}
