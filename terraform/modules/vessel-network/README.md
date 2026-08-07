# vessel-network

A vessel's private network boundary: VPC, subnet, and a Private Service
Access connection for Cloud SQL and Memorystore. Optional per vessel — a
vessel serving only Cloud Run and Firebase Hosting needs none of this.

The caller must pass `google.quota` as a provider aliased to the vessel with
`user_project_override` and `billing_project` set, or Service Networking
charges its API request to the project owning the impersonated service
account.

<!-- BEGIN_TF_DOCS -->
## Requirements

| Name | Version |
| ---- | ------- |
| <a name="requirement_terraform"></a> [terraform](#requirement\_terraform) | >= 1.11.0 |
| <a name="requirement_google"></a> [google](#requirement\_google) | >= 7.0.0 |

## Providers

| Name | Version |
| ---- | ------- |
| <a name="provider_google"></a> [google](#provider\_google) | >= 7.0.0 |
| <a name="provider_google.quota"></a> [google.quota](#provider\_google.quota) | >= 7.0.0 |

## Modules

No modules.

## Resources

| Name | Type |
| ---- | ---- |
| [google_compute_global_address.private_services](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/compute_global_address) | resource |
| [google_compute_network.vessel](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/compute_network) | resource |
| [google_compute_subnetwork.vessel](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/compute_subnetwork) | resource |
| [google_service_networking_connection.private_services](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/service_networking_connection) | resource |

## Inputs

| Name | Description | Type | Default | Required |
| ---- | ----------- | ---- | ------- | :------: |
| <a name="input_name"></a> [name](#input\_name) | Name shared by the network and subnetwork | `string` | `"spindrift-vessel"` | no |
| <a name="input_project"></a> [project](#input\_project) | The vessel project the network lives in | `string` | n/a | yes |
| <a name="input_region"></a> [region](#input\_region) | The region the subnetwork is created in | `string` | n/a | yes |
| <a name="input_subnet_cidr"></a> [subnet\_cidr](#input\_subnet\_cidr) | CIDR of the vessel subnet. Read from the vessel's topology SSOT, never typed inline. | `string` | n/a | yes |

## Outputs

No outputs.
<!-- END_TF_DOCS -->
