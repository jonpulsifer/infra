removed {
  from = unifi_client.personal_devices

  lifecycle {
    destroy = false
  }
}

removed {
  from = unifi_client.computers

  lifecycle {
    destroy = false
  }
}

removed {
  from = unifi_client.iot

  lifecycle {
    destroy = false
  }
}

removed {
  from = unifi_client.cameras

  lifecycle {
    destroy = false
  }
}

removed {
  from = unifi_client.lab

  lifecycle {
    destroy = false
  }
}
