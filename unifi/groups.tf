resource "unifi_user_group" "unmetered" {
  name              = "Unmetered"
  qos_rate_max_down = -1
  qos_rate_max_up   = -1
}

resource "unifi_user_group" "iot" {
  name              = "IoT"
  qos_rate_max_down = 5000
  qos_rate_max_up   = 5000
}

resource "unifi_user_group" "streaming" {
  name              = "Streaming Media"
  qos_rate_max_down = 100000
  qos_rate_max_up   = 100000
}
