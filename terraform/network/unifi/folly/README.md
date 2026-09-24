# folly UniFi

OpenTofu root for the folly UniFi gateway. See [Network](https://wiki.lolwtf.ca/platform/network/) on the wiki, and [Routing and firewall](https://wiki.lolwtf.ca/platform/network/routing-and-firewall/) for the BGP routes and zone policies.

It declares the networks and VLANs, WLANs, WAN, client QoS, DHCP reservations, DNS records, the `Lab` firewall zone and its policies, and the gateway's BGP config.

`topology.tf` reads both sites' `cluster-topology.json` and folly's `lab-topology.json`. `clients.yaml` holds the DHCP reservations, and a plan fails if its host addresses disagree with `lab-topology.json`. `bgp-folly.conf` is the FRR config for the gateway. Read the comment above `locals` in `firewall.tf` before you change a cross-site policy.

## Develop

```bash
tofu -chdir=terraform/network/unifi/folly init -backend=false
tofu -chdir=terraform/network/unifi/folly validate
TF_DIR=terraform/network/unifi/folly mise run tf:plan
```

A local plan needs Google credentials for the state bucket and `OP_SERVICE_ACCOUNT_TOKEN`; `versions.tf` names the 1Password item. `mise run tf:docs` regenerates the tables below.

## Deploy

Atlantis plans this root on a pull request that changes a `.tf` or `.conf` file in it. A change to only `clients.yaml` or `lab-topology.json` does not autoplan, so comment `atlantis plan -d terraform/network/unifi/folly`. Comment `atlantis apply` to apply the plan, and a successful apply merges the pull request. State is in `gs://homelab-ng/terraform/unifi`.

<!-- BEGIN_TF_DOCS -->
## Requirements

| Name | Version |
| ---- | ------- |
| <a name="requirement_cloudflare"></a> [cloudflare](#requirement\_cloudflare) | ~> 5.1 |
| <a name="requirement_onepassword"></a> [onepassword](#requirement\_onepassword) | ~> 3.0 |
| <a name="requirement_unifi"></a> [unifi](#requirement\_unifi) | ~> 0.55 |

## Providers

| Name | Version |
| ---- | ------- |
| <a name="provider_cloudflare"></a> [cloudflare](#provider\_cloudflare) | 5.24.0 |
| <a name="provider_onepassword"></a> [onepassword](#provider\_onepassword) | 3.3.1 |
| <a name="provider_unifi"></a> [unifi](#provider\_unifi) | 0.55.0 |

## Modules

| Name | Source | Version |
| ---- | ------ | ------- |
| <a name="module_lab_topology"></a> [lab\_topology](#module\_lab\_topology) | ../../../modules/cluster-topology | n/a |
| <a name="module_offsite_topology"></a> [offsite\_topology](#module\_offsite\_topology) | ../../../modules/cluster-topology | n/a |
| <a name="module_topology"></a> [topology](#module\_topology) | ../../../modules/cluster-topology | n/a |

## Resources

| Name | Type |
| ---- | ---- |
| [cloudflare_dns_record.k8s_remote_dns](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/dns_record) | resource |
| [cloudflare_dns_record.lab_remote_dns](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/dns_record) | resource |
| [cloudflare_dns_record.lab_service_dns](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/dns_record) | resource |
| [unifi_bgp.folly](https://registry.terraform.io/providers/ubiquiti-community/unifi/latest/docs/resources/bgp) | resource |
| [unifi_client.cathy](https://registry.terraform.io/providers/ubiquiti-community/unifi/latest/docs/resources/client) | resource |
| [unifi_client_qos_rate.iot](https://registry.terraform.io/providers/ubiquiti-community/unifi/latest/docs/resources/client_qos_rate) | resource |
| [unifi_client_qos_rate.streaming](https://registry.terraform.io/providers/ubiquiti-community/unifi/latest/docs/resources/client_qos_rate) | resource |
| [unifi_client_qos_rate.unmetered](https://registry.terraform.io/providers/ubiquiti-community/unifi/latest/docs/resources/client_qos_rate) | resource |
| [unifi_firewall_group.teleport_cidr](https://registry.terraform.io/providers/ubiquiti-community/unifi/latest/docs/resources/firewall_group) | resource |
| [unifi_firewall_policy.allow_established_related_external](https://registry.terraform.io/providers/ubiquiti-community/unifi/latest/docs/resources/firewall_policy) | resource |
| [unifi_firewall_policy.allow_established_related_hotspot](https://registry.terraform.io/providers/ubiquiti-community/unifi/latest/docs/resources/firewall_policy) | resource |
| [unifi_firewall_policy.allow_established_related_internal](https://registry.terraform.io/providers/ubiquiti-community/unifi/latest/docs/resources/firewall_policy) | resource |
| [unifi_firewall_policy.allow_established_related_vpn](https://registry.terraform.io/providers/ubiquiti-community/unifi/latest/docs/resources/firewall_policy) | resource |
| [unifi_firewall_policy.drop_invalid_external](https://registry.terraform.io/providers/ubiquiti-community/unifi/latest/docs/resources/firewall_policy) | resource |
| [unifi_firewall_policy.drop_invalid_hotspot](https://registry.terraform.io/providers/ubiquiti-community/unifi/latest/docs/resources/firewall_policy) | resource |
| [unifi_firewall_policy.drop_invalid_internal](https://registry.terraform.io/providers/ubiquiti-community/unifi/latest/docs/resources/firewall_policy) | resource |
| [unifi_firewall_policy.drop_invalid_vpn](https://registry.terraform.io/providers/ubiquiti-community/unifi/latest/docs/resources/firewall_policy) | resource |
| [unifi_firewall_policy.folly_k8s_to_nest_k8s](https://registry.terraform.io/providers/ubiquiti-community/unifi/latest/docs/resources/firewall_policy) | resource |
| [unifi_firewall_policy.folly_pbx_to_handset](https://registry.terraform.io/providers/ubiquiti-community/unifi/latest/docs/resources/firewall_policy) | resource |
| [unifi_firewall_policy.folly_lb_to_nest_lan](https://registry.terraform.io/providers/ubiquiti-community/unifi/latest/docs/resources/firewall_policy) | resource |
| [unifi_firewall_policy.internal_to_lab](https://registry.terraform.io/providers/ubiquiti-community/unifi/latest/docs/resources/firewall_policy) | resource |
| [unifi_firewall_policy.internal_to_nest_k8s](https://registry.terraform.io/providers/ubiquiti-community/unifi/latest/docs/resources/firewall_policy) | resource |
| [unifi_firewall_policy.lab_clients_to_nest_k8s](https://registry.terraform.io/providers/ubiquiti-community/unifi/latest/docs/resources/firewall_policy) | resource |
| [unifi_firewall_policy.lab_to_lab](https://registry.terraform.io/providers/ubiquiti-community/unifi/latest/docs/resources/firewall_policy) | resource |
| [unifi_firewall_policy.nest_k8s_to_folly_k8s](https://registry.terraform.io/providers/ubiquiti-community/unifi/latest/docs/resources/firewall_policy) | resource |
| [unifi_firewall_policy.prometheus_windows_exporters](https://registry.terraform.io/providers/ubiquiti-community/unifi/latest/docs/resources/firewall_policy) | resource |
| [unifi_firewall_policy.teleport_cidr_to_lab](https://registry.terraform.io/providers/ubiquiti-community/unifi/latest/docs/resources/firewall_policy) | resource |
| [unifi_firewall_zone.lab](https://registry.terraform.io/providers/ubiquiti-community/unifi/latest/docs/resources/firewall_zone) | resource |
| [unifi_network.fml](https://registry.terraform.io/providers/ubiquiti-community/unifi/latest/docs/resources/network) | resource |
| [unifi_network.future](https://registry.terraform.io/providers/ubiquiti-community/unifi/latest/docs/resources/network) | resource |
| [unifi_network.iot](https://registry.terraform.io/providers/ubiquiti-community/unifi/latest/docs/resources/network) | resource |
| [unifi_network.k8s](https://registry.terraform.io/providers/ubiquiti-community/unifi/latest/docs/resources/network) | resource |
| [unifi_network.lab](https://registry.terraform.io/providers/ubiquiti-community/unifi/latest/docs/resources/network) | resource |
| [unifi_static_route.starlink](https://registry.terraform.io/providers/ubiquiti-community/unifi/latest/docs/resources/static_route) | resource |
| [unifi_wan.starlink](https://registry.terraform.io/providers/ubiquiti-community/unifi/latest/docs/resources/wan) | resource |
| [unifi_wlan.fml](https://registry.terraform.io/providers/ubiquiti-community/unifi/latest/docs/resources/wlan) | resource |
| [unifi_wlan.lab](https://registry.terraform.io/providers/ubiquiti-community/unifi/latest/docs/resources/wlan) | resource |
| [cloudflare_zone.lab](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/data-sources/zone) | data source |
| [onepassword_item.wifi](https://registry.terraform.io/providers/1password/onepassword/latest/docs/data-sources/item) | data source |
| [unifi_ap_group.all_aps](https://registry.terraform.io/providers/ubiquiti-community/unifi/latest/docs/data-sources/ap_group) | data source |
| [unifi_firewall_zone.external](https://registry.terraform.io/providers/ubiquiti-community/unifi/latest/docs/data-sources/firewall_zone) | data source |
| [unifi_firewall_zone.hotspot](https://registry.terraform.io/providers/ubiquiti-community/unifi/latest/docs/data-sources/firewall_zone) | data source |
| [unifi_firewall_zone.internal](https://registry.terraform.io/providers/ubiquiti-community/unifi/latest/docs/data-sources/firewall_zone) | data source |
| [unifi_firewall_zone.vpn](https://registry.terraform.io/providers/ubiquiti-community/unifi/latest/docs/data-sources/firewall_zone) | data source |
| [unifi_network.nest](https://registry.terraform.io/providers/ubiquiti-community/unifi/latest/docs/data-sources/network) | data source |

## Inputs

No inputs.

## Outputs

No outputs.
<!-- END_TF_DOCS -->
