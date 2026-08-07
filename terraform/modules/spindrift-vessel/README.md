# spindrift-vessel

One project made a Spindrift vessel: enabled APIs, the runtime identity and
the controller's grants, and the Binary Authorization admission policy. The
home-vessel-only pieces (controller service account, federation bindings,
source bucket, cluster Secret Manager readers) stay in the home vessel's root.

Pass `services` and `controller_roles` as locals declared in the calling
root's `services.tf` and `iam.tf`: Spindrift's generated remediation stanzas
append flat resources to those files and dedupe by grepping them for the
quoted service/role strings, so the lists must live where the generator looks.

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
| [google_binary_authorization_policy.vessel](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/binary_authorization_policy) | resource |
| [google_org_policy_policy.require_binary_authorization](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/org_policy_policy) | resource |
| [google_project_iam_custom_role.bucket_lister](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/project_iam_custom_role) | resource |
| [google_project_iam_member.controller](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/project_iam_member) | resource |
| [google_project_iam_member.controller_bucket_lister](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/project_iam_member) | resource |
| [google_project_iam_member.runtime_secret_reader](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/project_iam_member) | resource |
| [google_project_service.service](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/project_service) | resource |
| [google_service_account.runtime](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/service_account) | resource |
| [google_service_account_iam_member.controller_acts_as_runtime](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/service_account_iam_member) | resource |

## Inputs

| Name | Description | Type | Default | Required |
| ---- | ----------- | ---- | ------- | :------: |
| <a name="input_attestor"></a> [attestor](#input\_attestor) | The Binary Authorization attestor every container admission must carry | `string` | `"projects/trusted-builds/attestors/provenance"` | no |
| <a name="input_controller_member"></a> [controller\_member](#input\_controller\_member) | The IAM member the Spindrift controller acts as in this vessel | `string` | n/a | yes |
| <a name="input_controller_roles"></a> [controller\_roles](#input\_controller\_roles) | Project roles the controller holds here. Pass from the root's iam.tf, for the same remediation-visibility reason as services. | `list(string)` | n/a | yes |
| <a name="input_project"></a> [project](#input\_project) | The project this vessel is, in the boundary's own terms | `string` | n/a | yes |
| <a name="input_runtime_account_id"></a> [runtime\_account\_id](#input\_runtime\_account\_id) | Account id of the runtime service account revisions and jobs run as | `string` | `"spindrift-runtime"` | no |
| <a name="input_services"></a> [services](#input\_services) | APIs enabled on the vessel. Pass this list from the root's services.tf so Spindrift's generated remediation stanzas can see the quoted service strings where they look for them. | `list(string)` | n/a | yes |

## Outputs

| Name | Description |
| ---- | ----------- |
| <a name="output_runtime_service_account"></a> [runtime\_service\_account](#output\_runtime\_service\_account) | The runtime service account revisions and jobs run as |
<!-- END_TF_DOCS -->
