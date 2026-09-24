# Prometheus scrape targets need fixed addresses, and `future`'s DHCP pool spans
# its whole range. prometheus_windows_exporters in firewall.tf opens the port.
locals {
  windows_hosts = {
    tallboy = {
      client     = local.clients.desktops.tallboy
      network_id = unifi_network.future.id
      cidr       = local.future_cidr
      fixed_ip   = local.lab_topology.TALLBOY_IP
    }
    # No network_id: the provider sends a network override, and the controller answers
    # VirtualNetworkOverrideUnsupportedForDefaultNetwork on Management.
    atomic = {
      client     = local.clients.desktops.atomic
      network_id = null
      cidr       = local.fml_cidr
      fixed_ip   = local.lab_topology.ATOMIC_IP
    }
  }
}

resource "unifi_client" "windows_hosts" {
  for_each = local.windows_hosts

  mac        = each.value.client.mac
  name       = each.key
  fixed_ip   = each.value.fixed_ip
  network_id = each.value.network_id
  note       = "terraform managed - windows_exporter scrape target"

  # The controller already knows these MACs.
  allow_existing         = true
  skip_forget_on_destroy = true

  lifecycle {
    precondition {
      condition     = each.value.fixed_ip == cidrhost(each.value.cidr, each.value.client.ip)
      error_message = "lab-topology.json's ${upper(each.key)}_IP disagrees with the clients.yaml octet for ${each.key}."
    }
  }
}
