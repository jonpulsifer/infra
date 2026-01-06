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
| <a name="provider_cloudflare"></a> [cloudflare](#provider\_cloudflare) | 5.15.0 |
| <a name="provider_onepassword"></a> [onepassword](#provider\_onepassword) | 3.0.2 |
| <a name="provider_unifi"></a> [unifi](#provider\_unifi) | 0.41.0 |
| <a name="provider_vault"></a> [vault](#provider\_vault) | 5.6.0 |

## Modules

No modules.

## Resources

| Name | Type |
|------|------|
| [cloudflare_dns_record.k8s_remote_dns](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/dns_record) | resource |
| [cloudflare_dns_record.lab_remote_dns](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/dns_record) | resource |
| [unifi_network.fml](https://registry.terraform.io/providers/paultyng/unifi/latest/docs/resources/network) | resource |
| [unifi_network.k8s](https://registry.terraform.io/providers/paultyng/unifi/latest/docs/resources/network) | resource |
| [unifi_network.lab](https://registry.terraform.io/providers/paultyng/unifi/latest/docs/resources/network) | resource |
| [unifi_network.starlink](https://registry.terraform.io/providers/paultyng/unifi/latest/docs/resources/network) | resource |
| [unifi_static_route.starlink](https://registry.terraform.io/providers/paultyng/unifi/latest/docs/resources/static_route) | resource |
| [unifi_user.cameras](https://registry.terraform.io/providers/paultyng/unifi/latest/docs/resources/user) | resource |
| [unifi_user.computers](https://registry.terraform.io/providers/paultyng/unifi/latest/docs/resources/user) | resource |
| [unifi_user.iot](https://registry.terraform.io/providers/paultyng/unifi/latest/docs/resources/user) | resource |
| [unifi_user.lab](https://registry.terraform.io/providers/paultyng/unifi/latest/docs/resources/user) | resource |
| [unifi_user.personal_devices](https://registry.terraform.io/providers/paultyng/unifi/latest/docs/resources/user) | resource |
| [unifi_user_group.iot](https://registry.terraform.io/providers/paultyng/unifi/latest/docs/resources/user_group) | resource |
| [unifi_user_group.streaming](https://registry.terraform.io/providers/paultyng/unifi/latest/docs/resources/user_group) | resource |
| [unifi_user_group.unmetered](https://registry.terraform.io/providers/paultyng/unifi/latest/docs/resources/user_group) | resource |
| [unifi_wlan.fml](https://registry.terraform.io/providers/paultyng/unifi/latest/docs/resources/wlan) | resource |
| [unifi_wlan.lab](https://registry.terraform.io/providers/paultyng/unifi/latest/docs/resources/wlan) | resource |
| [cloudflare_zone.lab](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/data-sources/zone) | data source |
| [onepassword_item.cloudflare_api_token](https://registry.terraform.io/providers/1password/onepassword/latest/docs/data-sources/item) | data source |
| [onepassword_item.unifi](https://registry.terraform.io/providers/1password/onepassword/latest/docs/data-sources/item) | data source |
| [onepassword_item.vault](https://registry.terraform.io/providers/1password/onepassword/latest/docs/data-sources/item) | data source |
| [unifi_ap_group.all_aps](https://registry.terraform.io/providers/paultyng/unifi/latest/docs/data-sources/ap_group) | data source |
| [unifi_ap_group.lab](https://registry.terraform.io/providers/paultyng/unifi/latest/docs/data-sources/ap_group) | data source |
| [vault_generic_secret.ddns_edge_pulsifer_ca](https://registry.terraform.io/providers/hashicorp/vault/latest/docs/data-sources/generic_secret) | data source |
| [vault_generic_secret.wifi](https://registry.terraform.io/providers/hashicorp/vault/latest/docs/data-sources/generic_secret) | data source |

## Inputs

No inputs.

## Outputs

No outputs.
<!-- END_TF_DOCS -->