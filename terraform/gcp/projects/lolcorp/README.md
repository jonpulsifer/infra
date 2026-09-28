# lolcorp

OpenTofu root for the `lolcorp` GCP project. See [Cloud](https://wiki.lolwtf.ca/platform/cloud/) on the wiki.

`policy.tf` sets the org policies a Google Workspace BigQuery export needs, and `services.tf` enables the project's APIs. Nothing runs in the project.

## Develop

```bash
tofu -chdir=terraform/gcp/projects/lolcorp init -backend=false
tofu -chdir=terraform/gcp/projects/lolcorp validate
TF_DIR=terraform/gcp/projects/lolcorp mise run tf:plan
```

A local plan needs Google credentials with access to the project and the state bucket. `mise run tf:docs` regenerates the tables below.

## Deploy

Atlantis plans this root on a pull request that changes it. Comment `atlantis apply` to apply the plan, and a successful apply merges the pull request. State is in `gs://homelab-ng/terraform/lolcorp`.

<!-- BEGIN_TF_DOCS -->
## Requirements

| Name | Version |
| ---- | ------- |
| <a name="requirement_terraform"></a> [terraform](#requirement\_terraform) | >= 1.3.3 |
| <a name="requirement_google"></a> [google](#requirement\_google) | ~> 8.3.0 |
| <a name="requirement_google-beta"></a> [google-beta](#requirement\_google-beta) | ~> 8.3.0 |

## Providers

| Name | Version |
| ---- | ------- |
| <a name="provider_google"></a> [google](#provider\_google) | 8.3.0 |

## Modules

No modules.

## Resources

| Name | Type |
| ---- | ---- |
| [google_bigquery_dataset.audit_anomalies](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/bigquery_dataset) | resource |
| [google_bigquery_table.anomalies](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/bigquery_table) | resource |
| [google_cloud_run_v2_service.audit_pipeline](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/cloud_run_v2_service) | resource |
| [google_org_policy_policy.allow_all_domains](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/org_policy_policy) | resource |
| [google_org_policy_policy.allowed_locations](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/org_policy_policy) | resource |
| [google_project_service.service](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/project_service) | resource |
| [google_service_account.audit_pipeline](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/service_account) | resource |

## Inputs

No inputs.

## Outputs

No outputs.
<!-- END_TF_DOCS -->