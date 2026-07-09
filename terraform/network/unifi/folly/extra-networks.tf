resource "unifi_network" "future" {
  name                          = "future"
  subnet                        = local.future_cidr
  vlan                          = 1337
  setting_preference            = "manual"
  auto_scale                    = true
  lte_lan                       = true
  multicast_dns                 = true
  ipv6_interface_type           = "pd"
  ipv6_pd_interface             = "wan"
  ipv6_ra                       = true
  ipv6_pd_auto_prefixid_enabled = true

  dhcp_server = {
    enabled     = true
    leasetime   = local.one_day
    start       = cidrhost(local.future_cidr, 2)
    stop        = cidrhost(local.future_cidr, 14)
    dns_enabled = true
    dns_servers = [local.lab.hosts.dns]
    boot = {
      enabled = false
    }
  }
}

resource "unifi_network" "iot" {
  name               = "iot"
  subnet             = local.iot_cidr
  vlan               = 666
  domain_name        = local.iot_domain
  setting_preference = "manual"
  auto_scale         = false
  lte_lan            = true
  network_isolation  = true
  multicast_dns      = true

  dhcp_server = {
    enabled     = true
    leasetime   = local.one_day
    start       = cidrhost(local.iot_cidr, 2)
    stop        = cidrhost(local.iot_cidr, 62)
    dns_enabled = true
    dns_servers = [local.lab.hosts.dns]
    boot = {
      enabled = false
    }
  }
}
