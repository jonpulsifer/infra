# spindrift-vessel

Module that makes one GCP project a kthx vessel, a boundary that kthx deploys into: its APIs, the runtime identity, the controller's grants, and the Binary Authorization admission policy. `terraform/gcp/projects/bluenose/vessel.tf` calls it. See [kthx built apps](https://wiki.lolwtf.ca/apps/kthx/built-apps/) on the wiki.

- Declare `services` and `controller_roles` as locals in the calling root's `services.tf` and `iam.tf`. kthx proposes Terraform for unmet prerequisites into those files and reads them to skip what they already declare.
- Pass `attestor` from the `spindrift-supply-chain` module's `attestor` output, or an existing `projects/*/attestors/*` ID.

The controller service account, federation bindings, source bucket and cluster Secret Manager readers stay in the home vessel's root.

## Develop

```bash
tofu -chdir=terraform/modules/spindrift-vessel init -backend=false
tofu -chdir=terraform/modules/spindrift-vessel validate
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
| <a name="input_attestor"></a> [attestor](#input\_attestor) | The Binary Authorization attestor every container admission must carry, as projects/*/attestors/* — the spindrift-supply-chain module's attestor output | `string` | n/a | yes |
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
