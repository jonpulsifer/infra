<!-- BEGIN_TF_DOCS -->
## Requirements

| Name | Version |
|------|---------|
| <a name="requirement_terraform"></a> [terraform](#requirement\_terraform) | >= 1.1.9 |
| <a name="requirement_google"></a> [google](#requirement\_google) | ~> 5.30.0 |
| <a name="requirement_google-beta"></a> [google-beta](#requirement\_google-beta) | ~> 4.84.0 |

## Providers

| Name | Version |
|------|---------|
| <a name="provider_google"></a> [google](#provider\_google) | 5.30.0 |
| <a name="provider_google-beta"></a> [google-beta](#provider\_google-beta) | 4.84.0 |

## Modules

No modules.

## Resources

| Name | Type |
|------|------|
| [google-beta_google_compute_instance_template.shielded_vm](https://registry.terraform.io/providers/hashicorp/google-beta/latest/docs/resources/google_compute_instance_template) | resource |
| [google_compute_address.static](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/compute_address) | resource |
| [google_compute_disk.pd](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/compute_disk) | resource |
| [google_compute_forwarding_rule.lb](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/compute_forwarding_rule) | resource |
| [google_compute_instance_group_manager.igm](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/compute_instance_group_manager) | resource |
| [google_compute_target_pool.lb](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/compute_target_pool) | resource |
| [google_kms_crypto_key.igm](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/kms_crypto_key) | resource |
| [google_kms_key_ring.igm](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/kms_key_ring) | resource |
| [google_kms_key_ring_iam_binding.igm](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/kms_key_ring_iam_binding) | resource |
| [google_project_iam_member.sd](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/project_iam_member) | resource |
| [google_service_account.igm](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/service_account) | resource |
| [google_storage_bucket_iam_member.cloudlab](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/storage_bucket_iam_member) | resource |
| [google_compute_image.trusted-image](https://registry.terraform.io/providers/hashicorp/google/latest/docs/data-sources/compute_image) | data source |
| [google_project.current](https://registry.terraform.io/providers/hashicorp/google/latest/docs/data-sources/project) | data source |

## Inputs

| Name | Description | Type | Default | Required |
|------|-------------|------|---------|:--------:|
| <a name="input_can_ip_forward"></a> [can\_ip\_forward](#input\_can\_ip\_forward) | Whether or not the instance can forward packets (eg wireguard needs this) | `bool` | `false` | no |
| <a name="input_cloud_init"></a> [cloud\_init](#input\_cloud\_init) | the user-data cloud-init script | `string` | `"#cloud-config\n"` | no |
| <a name="input_cloudlab"></a> [cloudlab](#input\_cloudlab) | Enable access to the gs://cloud-lab bucket. Caller must have permission to set the IAM policy | `bool` | `true` | no |
| <a name="input_enable_lb"></a> [enable\_lb](#input\_enable\_lb) | Enables or disables load balancing | `bool` | `false` | no |
| <a name="input_enable_secure_boot"></a> [enable\_secure\_boot](#input\_enable\_secure\_boot) | Enable UEFI etc | `bool` | `true` | no |
| <a name="input_enable_stackdriver"></a> [enable\_stackdriver](#input\_enable\_stackdriver) | Enable Stackdriver logging, monitoring, etc for the instance service account | `bool` | `true` | no |
| <a name="input_encrypt_disk"></a> [encrypt\_disk](#input\_encrypt\_disk) | Whether or not to encrypt the disk with KMS | `bool` | `true` | no |
| <a name="input_external_ip"></a> [external\_ip](#input\_external\_ip) | Create an external IP address for the instance | `bool` | `false` | no |
| <a name="input_image"></a> [image](#input\_image) | Map that holds the GCE image family and project | `map(string)` | <pre>{<br>  "family": "cos-beta",<br>  "project": "gce-uefi-images"<br>}</pre> | no |
| <a name="input_location"></a> [location](#input\_location) | The location, usually a region e.g. northamerica-northeast1 | `string` | `""` | no |
| <a name="input_machine_type"></a> [machine\_type](#input\_machine\_type) | GCE Machine Type | `string` | `"n1-standard-1"` | no |
| <a name="input_name"></a> [name](#input\_name) | Name for the service account and VM prefix | `string` | `"lab"` | no |
| <a name="input_persistent_disk"></a> [persistent\_disk](#input\_persistent\_disk) | Whether or not to add a persistent disk to the VM | `bool` | `false` | no |
| <a name="input_persistent_disk_size"></a> [persistent\_disk\_size](#input\_persistent\_disk\_size) | The size in GB of the persistent disk | `number` | `10` | no |
| <a name="input_persistent_disk_type"></a> [persistent\_disk\_type](#input\_persistent\_disk\_type) | The type of persistent disk to add to the VM | `string` | `"pd-standard"` | no |
| <a name="input_port_range"></a> [port\_range](#input\_port\_range) | Port range for the load balancer | `string` | `""` | no |
| <a name="input_preemptible"></a> [preemptible](#input\_preemptible) | Toggle if the instance is preemptible. Defaults to true | `string` | `"true"` | no |
| <a name="input_project"></a> [project](#input\_project) | The project that will contain the resources | `string` | `""` | no |
| <a name="input_protocol"></a> [protocol](#input\_protocol) | IP protocol for the load balancer | `string` | `"TCP"` | no |
| <a name="input_subnet"></a> [subnet](#input\_subnet) | Which subnet to deploy into | `string` | `"10.13.37.0/29"` | no |
| <a name="input_target_pools"></a> [target\_pools](#input\_target\_pools) | List of the target pools this igm belongs to | `list` | `[]` | no |
| <a name="input_target_size"></a> [target\_size](#input\_target\_size) | Count of instances to create (zonal) | `number` | `1` | no |

## Outputs

| Name | Description |
|------|-------------|
| <a name="output_service_account"></a> [service\_account](#output\_service\_account) | n/a |
<!-- END_TF_DOCS -->