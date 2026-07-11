locals {
  lan_cidr = "192.168.1.1/24"
  # node_cidr keeps the gateway-host (.1) form the UniFi network subnet expects;
  # cidrhost() masks host bits so the static_records/dhcp ranges below are unchanged.
  node_cidr = "${cidrhost(local.topology.K8S_NODE_CIDR, 1)}/${split("/", local.topology.K8S_NODE_CIDR)[1]}"
}

resource "unifi_network" "default" {
  name               = "Default"
  subnet             = local.lan_cidr
  domain_name        = "localdomain"
  setting_preference = "auto"
  auto_scale         = false
  lte_lan            = true
  multicast_dns      = true

  dhcp_server = {
    enabled   = true
    leasetime = local.one_day
    start     = cidrhost(local.lan_cidr, 6)
    stop      = cidrhost(local.lan_cidr, 254)
    boot = {
      enabled = false
    }
  }
}

resource "unifi_network" "k8s" {
  name               = "Kubernetes"
  subnet             = local.node_cidr
  vlan               = 2
  setting_preference = "auto"
  auto_scale         = false
  lte_lan            = true
  multicast_dns      = true

  dhcp_server = {
    enabled   = true
    leasetime = local.one_day
    start     = cidrhost(local.topology.K8S_NODE_CIDR, 2)
    stop      = cidrhost(local.topology.K8S_NODE_CIDR, 14)
    boot = {
      enabled = false
    }
  }
}

data "unifi_network" "folly" {
  name = "fml.pulsifer.ca"
}
