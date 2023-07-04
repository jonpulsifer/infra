<!-- BEGIN_TF_DOCS -->
## Requirements

| Name | Version |
|------|---------|
| <a name="requirement_terraform"></a> [terraform](#requirement\_terraform) | >= 1.1.9 |
| <a name="requirement_google"></a> [google](#requirement\_google) | ~> 4.72.0 |
| <a name="requirement_google-beta"></a> [google-beta](#requirement\_google-beta) | ~> 4.72.0 |

## Providers

| Name | Version |
|------|---------|
| <a name="provider_google"></a> [google](#provider\_google) | 4.72.0 |

## Modules

No modules.

## Resources

| Name | Type |
|------|------|
| [google_app_engine_application.app](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/app_engine_application) | resource |
| [google_app_engine_domain_mapping.app](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/app_engine_domain_mapping) | resource |
| [google_app_engine_firewall_rule.app](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/app_engine_firewall_rule) | resource |
| [google_project_iam_member.sd](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/project_iam_member) | resource |
| [google_service_account.gae](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/service_account) | resource |

## Inputs

| Name | Description | Type | Default | Required |
|------|-------------|------|---------|:--------:|
| <a name="input_auth_domain"></a> [auth\_domain](#input\_auth\_domain) | The domain to authenticate users with when using App Engine's User API | `string` | `"pulsifer.ca"` | no |
| <a name="input_domain_names"></a> [domain\_names](#input\_domain\_names) | Map of domain names | `any` | `null` | no |
| <a name="input_enable_stackdriver"></a> [enable\_stackdriver](#input\_enable\_stackdriver) | Enable Stackdriver logging, monitoring, etc for the instance service account | `bool` | `false` | no |
| <a name="input_firewall_rules"></a> [firewall\_rules](#input\_firewall\_rules) | List of firewall rules | `map(object({ action = string, source_range = string, priority = number }))` | <pre>{<br>  "deny all the things": {<br>    "action": "DENY",<br>    "priority": 1337,<br>    "source_range": "*"<br>  }<br>}</pre> | no |
| <a name="input_location"></a> [location](#input\_location) | The location, usually a region e.g. northamerica-northeast1 | `string` | `"northamerica-northeast1"` | no |
| <a name="input_name"></a> [name](#input\_name) | Name for the AppEngine application | `string` | `"app"` | no |
| <a name="input_project"></a> [project](#input\_project) | The project that will contain the application | `string` | `""` | no |
| <a name="input_serving_status"></a> [serving\_status](#input\_serving\_status) | The serving status of the app | `string` | `"SERVING"` | no |

## Outputs

| Name | Description |
|------|-------------|
| <a name="output_service_account"></a> [service\_account](#output\_service\_account) | n/a |
| <a name="output_service_account_name"></a> [service\_account\_name](#output\_service\_account\_name) | n/a |
<!-- END_TF_DOCS -->