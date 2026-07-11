# k8s_cidr is the /28 network, not the full CIDR prefix. The cluster-topology
# holds the /28 (K8S_NODE_CIDR = "10.89.0.0/28"), but unifi_network.subnet
# requires the full CIDR notation with mask (e.g. "10.89.0.0/28"), so we take the
# node CIDR as-is. The DHCP range is derived from it.
locals {
  lan_cidr = "192.168.1.1/24"
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
  subnet             = local.topology.K8S_NODE_CIDR
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
