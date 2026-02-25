<!-- BEGIN_TF_DOCS -->
## Requirements

| Name | Version |
|------|---------|
| <a name="requirement_cloudflare"></a> [cloudflare](#requirement\_cloudflare) | ~> 5.1 |
| <a name="requirement_onepassword"></a> [onepassword](#requirement\_onepassword) | ~> 3.0 |
| <a name="requirement_unifi"></a> [unifi](#requirement\_unifi) | ~> 0.41 |
| <a name="requirement_vault"></a> [vault](#requirement\_vault) | ~> 5.0 |

## Providers

| Name | Version |
|------|---------|
| <a name="provider_cloudflare"></a> [cloudflare](#provider\_cloudflare) | 5.17.0 |
| <a name="provider_unifi"></a> [unifi](#provider\_unifi) | 0.41.13 |
| <a name="provider_vault"></a> [vault](#provider\_vault) | 5.7.0 |

## Modules

No modules.

## Resources

| Name | Type |
|------|------|
| [cloudflare_dns_record.k8s_remote_dns](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/dns_record) | resource |
| [cloudflare_dns_record.lab_remote_dns](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/dns_record) | resource |
| [unifi_client.cameras](https://registry.terraform.io/providers/ubiquiti-community/unifi/latest/docs/resources/client) | resource |
| [unifi_client.computers](https://registry.terraform.io/providers/ubiquiti-community/unifi/latest/docs/resources/client) | resource |
| [unifi_client.iot](https://registry.terraform.io/providers/ubiquiti-community/unifi/latest/docs/resources/client) | resource |
| [unifi_client.lab](https://registry.terraform.io/providers/ubiquiti-community/unifi/latest/docs/resources/client) | resource |
| [unifi_client.personal_devices](https://registry.terraform.io/providers/ubiquiti-community/unifi/latest/docs/resources/client) | resource |
| [unifi_client_group.iot](https://registry.terraform.io/providers/ubiquiti-community/unifi/latest/docs/resources/client_group) | resource |
| [unifi_client_group.streaming](https://registry.terraform.io/providers/ubiquiti-community/unifi/latest/docs/resources/client_group) | resource |
| [unifi_client_group.unmetered](https://registry.terraform.io/providers/ubiquiti-community/unifi/latest/docs/resources/client_group) | resource |
| [unifi_network.fml](https://registry.terraform.io/providers/ubiquiti-community/unifi/latest/docs/resources/network) | resource |
| [unifi_network.k8s](https://registry.terraform.io/providers/ubiquiti-community/unifi/latest/docs/resources/network) | resource |
| [unifi_network.lab](https://registry.terraform.io/providers/ubiquiti-community/unifi/latest/docs/resources/network) | resource |
| [unifi_network.starlink](https://registry.terraform.io/providers/ubiquiti-community/unifi/latest/docs/resources/network) | resource |
| [unifi_static_route.starlink](https://registry.terraform.io/providers/ubiquiti-community/unifi/latest/docs/resources/static_route) | resource |
| [unifi_wlan.fml](https://registry.terraform.io/providers/ubiquiti-community/unifi/latest/docs/resources/wlan) | resource |
| [unifi_wlan.lab](https://registry.terraform.io/providers/ubiquiti-community/unifi/latest/docs/resources/wlan) | resource |
| [cloudflare_zone.lab](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/data-sources/zone) | data source |
| [unifi_ap_group.all_aps](https://registry.terraform.io/providers/ubiquiti-community/unifi/latest/docs/data-sources/ap_group) | data source |
| [unifi_ap_group.lab](https://registry.terraform.io/providers/ubiquiti-community/unifi/latest/docs/data-sources/ap_group) | data source |
| [vault_generic_secret.ddns_edge_pulsifer_ca](https://registry.terraform.io/providers/hashicorp/vault/latest/docs/data-sources/generic_secret) | data source |
| [vault_generic_secret.wifi](https://registry.terraform.io/providers/hashicorp/vault/latest/docs/data-sources/generic_secret) | data source |

## Inputs

No inputs.

## Outputs

No outputs.
<!-- END_TF_DOCS -->