<!-- BEGIN_TF_DOCS -->
## Requirements

| Name | Version |
|------|---------|
| <a name="requirement_terraform"></a> [terraform](#requirement\_terraform) | >= 1.1.9 |
| <a name="requirement_google"></a> [google](#requirement\_google) | ~> 4.60.0 |
| <a name="requirement_google-beta"></a> [google-beta](#requirement\_google-beta) | ~> 4.59.0 |

## Providers

| Name | Version |
|------|---------|
| <a name="provider_google-beta"></a> [google-beta](#provider\_google-beta) | 4.59.0 |

## Modules

No modules.

## Resources

| Name | Type |
|------|------|
| [google-beta_google_container_node_pool.lab](https://registry.terraform.io/providers/hashicorp/google-beta/latest/docs/resources/google_container_node_pool) | resource |

## Inputs

| Name | Description | Type | Default | Required |
|------|-------------|------|---------|:--------:|
| <a name="input_cluster"></a> [cluster](#input\_cluster) | n/a | `string` | `"yourcluster"` | no |
| <a name="input_disk_size_gb"></a> [disk\_size\_gb](#input\_disk\_size\_gb) | n/a | `number` | `10` | no |
| <a name="input_image_type"></a> [image\_type](#input\_image\_type) | n/a | `string` | `"COS_CONTAINERD"` | no |
| <a name="input_kubernetes_version"></a> [kubernetes\_version](#input\_kubernetes\_version) | n/a | `string` | `"1.11.6-gke.0"` | no |
| <a name="input_labels"></a> [labels](#input\_labels) | n/a | `map` | `{}` | no |
| <a name="input_location"></a> [location](#input\_location) | n/a | `string` | n/a | yes |
| <a name="input_machine_type"></a> [machine\_type](#input\_machine\_type) | n/a | `string` | `"custom-1-1"` | no |
| <a name="input_metadata_cos"></a> [metadata\_cos](#input\_metadata\_cos) | GCE instance metadata pairs assigned to the instances in the group | `map` | <pre>{<br>  "disable-legacy-endpoints": "true",<br>  "enable-guest-attributes": "false",<br>  "enable-os-inventory": "false"<br>}</pre> | no |
| <a name="input_metadata_ubuntu"></a> [metadata\_ubuntu](#input\_metadata\_ubuntu) | GCE instance metadata pairs assigned to the instances in the group | `map` | <pre>{<br>  "disable-legacy-endpoints": "true",<br>  "enable-guest-attributes": "true",<br>  "enable-os-inventory": "true"<br>}</pre> | no |
| <a name="input_name"></a> [name](#input\_name) | n/a | `string` | `"labpool"` | no |
| <a name="input_node_count"></a> [node\_count](#input\_node\_count) | n/a | `number` | `0` | no |
| <a name="input_node_metadata"></a> [node\_metadata](#input\_node\_metadata) | Adjusts the node metadata service, one of: GCE\_METADATA, GKE\_METADATA | `string` | `"GKE_METADATA"` | no |
| <a name="input_preemptible"></a> [preemptible](#input\_preemptible) | n/a | `bool` | `true` | no |
| <a name="input_service_account"></a> [service\_account](#input\_service\_account) | n/a | `string` | `"foo@your-project.iam.gserviceaccount.com"` | no |
| <a name="input_shielded"></a> [shielded](#input\_shielded) | Forces the nodes to use shielded (uefi) images and enables secure boot | `bool` | `true` | no |
| <a name="input_tags"></a> [tags](#input\_tags) | n/a | `list` | `[]` | no |
| <a name="input_taints"></a> [taints](#input\_taints) | n/a | `list` | `[]` | no |

## Outputs

No outputs.
<!-- END_TF_DOCS -->