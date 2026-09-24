# offsite UniFi

OpenTofu root for the offsite UniFi gateway: networks, WANs, WLANs and the gateway's BGP config. See [Network](https://wiki.lolwtf.ca/platform/network/) on the wiki, and [Routing and firewall](https://wiki.lolwtf.ca/platform/network/routing-and-firewall/) for the BGP routes and zone policies.

`topology.tf` reads `clusters/offsite/config/cluster-topology.json`. `bgp.conf` is the FRR config for the gateway. This root declares no firewall policies, because the offsite Kubernetes network is in the built-in `Internal` zone. If that network moves to a custom zone, copy folly's cross-site policies from `terraform/network/unifi/folly/firewall.tf`.

## Develop

```bash
tofu -chdir=terraform/network/unifi/offsite init -backend=false
tofu -chdir=terraform/network/unifi/offsite validate
TF_DIR=terraform/network/unifi/offsite mise run tf:plan
```

A local plan needs Google credentials for the state bucket and `OP_SERVICE_ACCOUNT_TOKEN`; `versions.tf` names the 1Password item. `mise run tf:docs` regenerates the tables below.

## Deploy

Atlantis plans this root on a pull request that changes it. Comment `atlantis apply` to apply the plan, and a successful apply merges the pull request. State is in `gs://homelab-ng/terraform/unifi/offsite`.

<!-- BEGIN_TF_DOCS -->
## Requirements

| Name | Version |
| ---- | ------- |
| <a name="requirement_onepassword"></a> [onepassword](#requirement\_onepassword) | ~> 3.0 |
| <a name="requirement_unifi"></a> [unifi](#requirement\_unifi) | ~> 0.55 |

## Providers

| Name | Version |
| ---- | ------- |
| <a name="provider_unifi"></a> [unifi](#provider\_unifi) | 0.55.0 |

## Modules

| Name | Source | Version |
| ---- | ------ | ------- |
| <a name="module_topology"></a> [topology](#module\_topology) | ../../../modules/cluster-topology | n/a |

## Resources

| Name | Type |
| ---- | ---- |
| [unifi_bgp.offsite](https://registry.terraform.io/providers/ubiquiti-community/unifi/latest/docs/resources/bgp) | resource |
| [unifi_network.default](https://registry.terraform.io/providers/ubiquiti-community/unifi/latest/docs/resources/network) | resource |
| [unifi_network.k8s](https://registry.terraform.io/providers/ubiquiti-community/unifi/latest/docs/resources/network) | resource |
| [unifi_wan.internet_1](https://registry.terraform.io/providers/ubiquiti-community/unifi/latest/docs/resources/wan) | resource |
| [unifi_wan.internet_2](https://registry.terraform.io/providers/ubiquiti-community/unifi/latest/docs/resources/wan) | resource |
| [unifi_wlan.goggly](https://registry.terraform.io/providers/ubiquiti-community/unifi/latest/docs/resources/wlan) | resource |
| [unifi_wlan.nest](https://registry.terraform.io/providers/ubiquiti-community/unifi/latest/docs/resources/wlan) | resource |
| [unifi_ap_group.all_aps](https://registry.terraform.io/providers/ubiquiti-community/unifi/latest/docs/data-sources/ap_group) | data source |
| [unifi_client_qos_rate.default](https://registry.terraform.io/providers/ubiquiti-community/unifi/latest/docs/data-sources/client_qos_rate) | data source |
| [unifi_network.folly](https://registry.terraform.io/providers/ubiquiti-community/unifi/latest/docs/data-sources/network) | data source |

## Inputs

No inputs.

## Outputs

No outputs.
<!-- END_TF_DOCS -->
