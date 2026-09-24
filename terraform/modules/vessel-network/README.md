# vessel-network

Module for a vessel's private network: a VPC, a subnet, and Private Service Connect policies that let Cloud SQL and Memorystore for Valkey create endpoints in the subnet. `terraform/gcp/projects/bluenose/vessel.tf` calls it. See [kthx built apps](https://wiki.lolwtf.ca/apps/kthx/built-apps/) on the wiki.

A vessel that serves only Cloud Run and Firebase Hosting does not need this module. The two outputs are the vessel's `location.network` block in the kthx installation manifest.

## Develop

```bash
tofu -chdir=terraform/modules/vessel-network init -backend=false
tofu -chdir=terraform/modules/vessel-network validate
```

`mise run tf:docs` regenerates the tables below. Atlantis plans `terraform/gcp/projects/bluenose` when this module changes.

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

## Modules

No modules.

## Resources

| Name | Type |
| ---- | ---- |
| [google_compute_network.vessel](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/compute_network) | resource |
| [google_compute_subnetwork.vessel](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/compute_subnetwork) | resource |
| [google_network_connectivity_service_connection_policy.cloudsql](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/network_connectivity_service_connection_policy) | resource |
| [google_network_connectivity_service_connection_policy.memorystore](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/network_connectivity_service_connection_policy) | resource |

## Inputs

| Name | Description | Type | Default | Required |
| ---- | ----------- | ---- | ------- | :------: |
| <a name="input_name"></a> [name](#input\_name) | Name shared by the network and subnetwork | `string` | `"spindrift-vessel"` | no |
| <a name="input_project"></a> [project](#input\_project) | The vessel project the network lives in | `string` | n/a | yes |
| <a name="input_region"></a> [region](#input\_region) | The region the subnetwork is created in | `string` | n/a | yes |
| <a name="input_subnet_cidr"></a> [subnet\_cidr](#input\_subnet\_cidr) | CIDR of the vessel subnet. Read from the vessel's topology SSOT, never typed inline. | `string` | n/a | yes |

## Outputs

| Name | Description |
| ---- | ----------- |
| <a name="output_network_name"></a> [network\_name](#output\_network\_name) | The consumer network a PSC endpoint is created in — the vessel's location.network.name in the installation manifest. |
| <a name="output_region"></a> [region](#output\_region) | Where the service connection policies and subnet are — the vessel's location.network.region in the installation manifest. |
<!-- END_TF_DOCS -->
