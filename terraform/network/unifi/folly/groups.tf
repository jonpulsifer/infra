resource "unifi_client_qos_rate" "unmetered" {
  name = "Unlimited Power"
}

resource "unifi_client_qos_rate" "iot" {
  name = "IoT"
}

resource "unifi_client_qos_rate" "streaming" {
  name = "Streaming Media"
}
