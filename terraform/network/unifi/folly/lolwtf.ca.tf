locals {
  # Gateway-host (.1) form of the anchor-topology ConfigMap's CIDR.
  anchor_cidr = "${cidrhost(local.anchor.cidr, 1)}/${split("/", local.anchor.cidr)[1]}"
  lab_domain  = "lolwtf.ca"
  lab_wlan    = "lab"
  lab_clients = merge(local.clients.lab, local.clients.rpis)
  # The anchors' VIPs (nix/services/anchor-vips.nix), never one Pi.
  dns_servers = [
    local.anchor_topology.NS1_IP,
    local.anchor_topology.NS2_IP,
  ]
  lab_service_records = {
    dns-ns1 = {
      name    = "dns"
      content = local.anchor_topology.NS1_IP
    }
    dns-ns2 = {
      name    = "dns"
      content = local.anchor_topology.NS2_IP
    }
    time-ns1 = {
      name    = "time"
      content = local.anchor_topology.NS1_IP
    }
    time-ns2 = {
      name    = "time"
      content = local.anchor_topology.NS2_IP
    }
    ns1 = {
      name    = "ns1"
      content = local.anchor_topology.NS1_IP
    }
    ns2 = {
      name    = "ns2"
      content = local.anchor_topology.NS2_IP
    }
    s3 = {
      name    = "s3"
      content = local.anchor_topology.S3_VIP
    }
  }
}

data "cloudflare_zone" "lab" {
  filter = {
    name   = local.lab_domain
    status = "active"
  }
}

resource "cloudflare_dns_record" "lab_remote_dns" {
  for_each = {
    for name, client in local.lab_clients : name => client
    if can(client.ip == true)
  }
  zone_id = data.cloudflare_zone.lab.zone_id
  name    = "${each.key}.${local.lab_domain}"
  content = cidrhost(local.anchor_cidr, each.value.ip)
  type    = "A"
  ttl     = 1
  comment = "terraform managed"
  proxied = false
}

moved {
  from = cloudflare_dns_record.lab_remote_dns["dns"]
  to   = cloudflare_dns_record.lab_service_dns["dns-capsule"]
}

moved {
  from = cloudflare_dns_record.lab_service_dns["dns-capsule"]
  to   = cloudflare_dns_record.lab_service_dns["dns-ns1"]
}

moved {
  from = cloudflare_dns_record.lab_service_dns["dns-spore"]
  to   = cloudflare_dns_record.lab_service_dns["dns-ns2"]
}

moved {
  from = cloudflare_dns_record.lab_service_dns["time-capsule"]
  to   = cloudflare_dns_record.lab_service_dns["time-ns1"]
}

moved {
  from = cloudflare_dns_record.lab_service_dns["time-spore"]
  to   = cloudflare_dns_record.lab_service_dns["time-ns2"]
}

resource "cloudflare_dns_record" "lab_service_dns" {
  for_each = local.lab_service_records

  zone_id = data.cloudflare_zone.lab.zone_id
  name    = "${each.value.name}.${local.lab_domain}"
  content = each.value.content
  type    = "A"
  ttl     = 1
  comment = "terraform managed service record"
  proxied = false
}

resource "unifi_network" "lab" {
  name               = local.network_catalog.anchor.name
  subnet             = local.anchor_cidr
  vlan               = local.network_catalog.anchor.vlan
  domain_name        = local.lab_domain
  setting_preference = "manual"
  auto_scale         = false
  lte_lan            = false
  network_isolation  = true
  multicast_dns      = false

  dhcp_server = {
    enabled   = true
    leasetime = local.one_week
    start     = cidrhost(local.anchor_cidr, 200)
    stop      = cidrhost(local.anchor_cidr, 254)
    boot = {
      enabled = false
    }
  }

  # anchor-topology.json and clients.yaml both hold these host addresses; keep them equal.
  lifecycle {
    precondition {
      condition = alltrue([
        local.anchor.hosts.capsule == cidrhost(local.anchor_cidr, local.clients.rpis.capsule.ip),
        local.anchor.hosts.spore == cidrhost(local.anchor_cidr, local.clients.rpis.spore.ip),
        local.anchor.hosts.forge == cidrhost(local.anchor_cidr, local.clients.rpis.forge.ip),
        local.anchor_topology.CLOUDPI4_IP == cidrhost(local.anchor_cidr, local.clients.rpis.cloudpi4.ip),
        local.anchor_topology.RADIOPI0_IP == cidrhost(local.anchor_cidr, local.clients.rpis.radiopi0.ip),
      ])
      error_message = "Host IPs in anchor-topology.json disagree with the clients.yaml octets."
    }
  }
}

resource "unifi_wlan" "lab" {
  name      = local.lab_wlan
  security  = "open"
  hide_ssid = true
  ap_group = {
    ids  = [unifi_ap_group.lab_only.id]
    mode = "devices"
  }
  network_id                = unifi_network.lab.id
  user_group_id             = unifi_client_qos_rate.unmetered.id
  multicast_enhance         = false
  bss_transition            = false
  no2ghz_oui                = false
  uapsd                     = true
  wlan_band                 = "both"
  wlan_bands                = ["2g", "5g"]
  minimum_data_rate_2g_kbps = 1000
  minimum_data_rate_5g_kbps = 6000

  lifecycle {
    ignore_changes = [passphrase]
  }
}
