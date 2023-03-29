<!-- BEGIN_TF_DOCS -->
## Requirements

| Name | Version |
|------|---------|
| <a name="requirement_terraform"></a> [terraform](#requirement\_terraform) | >= 1.1.9 |
| <a name="requirement_google"></a> [google](#requirement\_google) | ~> 4.59.0 |
| <a name="requirement_google-beta"></a> [google-beta](#requirement\_google-beta) | ~> 4.58.0 |

## Providers

| Name | Version |
|------|---------|
| <a name="provider_google"></a> [google](#provider\_google) | 4.59.0 |
| <a name="provider_google-beta"></a> [google-beta](#provider\_google-beta) | 4.58.0 |

## Modules

No modules.

## Resources

| Name | Type |
|------|------|
| [google-beta_google_compute_subnetwork.subnet](https://registry.terraform.io/providers/hashicorp/google-beta/latest/docs/resources/google_compute_subnetwork) | resource |
| [google_compute_firewall.ssh](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/compute_firewall) | resource |
| [google_compute_network.network](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/compute_network) | resource |

## Inputs

| Name | Description | Type | Default | Required |
|------|-------------|------|---------|:--------:|
| <a name="input_auto_create_subnetworks"></a> [auto\_create\_subnetworks](#input\_auto\_create\_subnetworks) | Enables the automatic creation of default subnets, the easy button in a pinch | `bool` | `false` | no |
| <a name="input_enable_logging"></a> [enable\_logging](#input\_enable\_logging) | Enables flow logs (INTERVAL\_10\_MIN, 0.5 sample, INCLUDE\_ALL\_METADATA) | `bool` | `false` | no |
| <a name="input_external_ssh"></a> [external\_ssh](#input\_external\_ssh) | Enable the IAP ssh firewall rules, if true, allow all inbound SSH | `bool` | `false` | no |
| <a name="input_ip_cidr_range"></a> [ip\_cidr\_range](#input\_ip\_cidr\_range) | The default CIDR for the subnet | `string` | `"10.13.37.0/28"` | no |
| <a name="input_name"></a> [name](#input\_name) | The name for the network | `string` | n/a | yes |
| <a name="input_private_api_access"></a> [private\_api\_access](#input\_private\_api\_access) | Access to Google APIs over RFC1918 networks | `bool` | `true` | no |
| <a name="input_subnet_name"></a> [subnet\_name](#input\_subnet\_name) | The name for the subnetwork | `string` | n/a | yes |

## Outputs

| Name | Description |
|------|-------------|
| <a name="output_network"></a> [network](#output\_network) | n/a |
| <a name="output_subnet"></a> [subnet](#output\_subnet) | n/a |
<!-- END_TF_DOCS -->