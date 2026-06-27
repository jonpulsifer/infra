# Offsite UniFi network

Terraform root for the offsite UniFi console at `https://10.89.0.1`.

State: `gs://homelab-ng/terraform/unifi/offsite`

This root owns the offsite gateway networks, WANs, WLANs, and BGP/FRR config.
Applies run through Atlantis on PRs; do not run `terraform apply` locally.

<!-- BEGIN_TF_DOCS -->
## Requirements

| Name | Version |
| ---- | ------- |
| <a name="requirement_onepassword"></a> [onepassword](#requirement\_onepassword) | ~> 3.0 |
| <a name="requirement_unifi"></a> [unifi](#requirement\_unifi) | ~> 0.53 |

## Providers

| Name | Version |
| ---- | ------- |
| <a name="provider_unifi"></a> [unifi](#provider\_unifi) | 0.53.0 |

## Modules

No modules.

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
