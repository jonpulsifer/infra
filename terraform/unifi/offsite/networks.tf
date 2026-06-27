locals {
  lan_cidr = "192.168.1.1/24"
  k8s_cidr = "10.89.0.1/28"
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
  subnet             = local.k8s_cidr
  vlan               = 2
  setting_preference = "auto"
  auto_scale         = false
  lte_lan            = true
  multicast_dns      = true

  dhcp_server = {
    enabled   = true
    leasetime = local.one_day
    start     = cidrhost(local.k8s_cidr, 2)
    stop      = cidrhost(local.k8s_cidr, 14)
    boot = {
      enabled = false
    }
  }
}

data "unifi_network" "folly" {
  name = "fml.pulsifer.ca"
}
