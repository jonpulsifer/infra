<!-- BEGIN_TF_DOCS -->
## Requirements

| Name | Version |
|------|---------|
| <a name="requirement_terraform"></a> [terraform](#requirement\_terraform) | >= 1.1.9 |
| <a name="requirement_google"></a> [google](#requirement\_google) | ~> 4.83.0 |
| <a name="requirement_google-beta"></a> [google-beta](#requirement\_google-beta) | ~> 4.83.0 |

## Providers

| Name | Version |
|------|---------|
| <a name="provider_google"></a> [google](#provider\_google) | 4.83.0 |

## Modules

No modules.

## Resources

| Name | Type |
|------|------|
| [google_compute_project_metadata_item.guest_attributes](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/compute_project_metadata_item) | resource |
| [google_compute_project_metadata_item.os_config](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/compute_project_metadata_item) | resource |
| [google_compute_project_metadata_item.os_inventory](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/compute_project_metadata_item) | resource |
| [google_compute_project_metadata_item.oslogin](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/compute_project_metadata_item) | resource |
| [google_compute_project_metadata_item.oslogin_2fa](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/compute_project_metadata_item) | resource |
| [google_project.project](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/project) | resource |
| [google_project_service.compute](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/project_service) | resource |
| [google_resource_manager_lien.project_deletion](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/resource_manager_lien) | resource |

## Inputs

| Name | Description | Type | Default | Required |
|------|-------------|------|---------|:--------:|
| <a name="input_billing_account"></a> [billing\_account](#input\_billing\_account) | The billing account for the project | `string` | `""` | no |
| <a name="input_compute"></a> [compute](#input\_compute) | Default false. Whether or not to enable the compute metadata at the project level | `bool` | `false` | no |
| <a name="input_folder_id"></a> [folder\_id](#input\_folder\_id) | The parent folder for this project. | `string` | `null` | no |
| <a name="input_labels"></a> [labels](#input\_labels) | The labels for the project | `map` | `{}` | no |
| <a name="input_name"></a> [name](#input\_name) | Optional. The name for the project (human readable) | `string` | `""` | no |
| <a name="input_project_id"></a> [project\_id](#input\_project\_id) | Required. The project id, 6 to 30 lowercase letters, digits, or hyphens. | `string` | `""` | no |

## Outputs

No outputs.
<!-- END_TF_DOCS -->