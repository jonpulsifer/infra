# The Windows desktops folly's Prometheus scrapes on 9182.
#
# A scrape target needs an address that outlives a DHCP lease, and `future`'s
# pool covers that network's entire usable range, so each host is reserved
# here. The addresses come from clusters/folly/config/lab-topology.json — the
# same ConfigMap clusters/folly/monitoring substitutes into the EndpointSlice
# — and the precondition below fails the plan if that file and clients.yaml
# ever disagree about where a host lives.
#
# The zone path is already open: `prometheus_windows_exporters` in firewall.tf
# allows Lab -> Internal on 9182, and both Management and `future` are
# Internal networks while Lab Net and Kubernetes are the Lab zone.
locals {
  windows_hosts = {
    tallboy = {
      client     = local.clients.desktops.tallboy
      network_id = unifi_network.future.id
      cidr       = local.future_cidr
      fixed_ip   = local.lab_topology.TALLBOY_IP
    }
    # No network_id. The provider turns one into a virtual-network override,
    # and the controller answers VirtualNetworkOverrideUnsupportedForDefaultNetwork
    # when the target is the default network, which Management is. A client
    # takes its address from the network it connects on, so the reservation
    # alone is both sufficient and the only thing the controller will accept.
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

  # The controller already knows both MACs — atomic with a hand-set fixed IP
  # and tallboy with a stale one outside its own /28 — so the resource adopts
  # them instead of failing on a client it did not create.
  allow_existing         = true
  skip_forget_on_destroy = true

  lifecycle {
    precondition {
      condition     = each.value.fixed_ip == cidrhost(each.value.cidr, each.value.client.ip)
      error_message = "lab-topology.json's ${upper(each.key)}_IP disagrees with the clients.yaml octet for ${each.key}."
    }
  }
}
