<!-- BEGIN_TF_DOCS -->
## Requirements

| Name | Version |
|------|---------|
| <a name="requirement_terraform"></a> [terraform](#requirement\_terraform) | >= 1.2.0 |
| <a name="requirement_google"></a> [google](#requirement\_google) | ~> 7.5.0 |
| <a name="requirement_google-beta"></a> [google-beta](#requirement\_google-beta) | ~> 7.5.0 |

## Providers

| Name | Version |
|------|---------|
| <a name="provider_google"></a> [google](#provider\_google) | 7.5.0 |
| <a name="provider_google-beta"></a> [google-beta](#provider\_google-beta) | 7.5.0 |

## Modules

No modules.

## Resources

| Name | Type |
|------|------|
| [google-beta_google_artifact_registry_repository.images](https://registry.terraform.io/providers/hashicorp/google-beta/latest/docs/resources/google_artifact_registry_repository) | resource |
| [google-beta_google_artifact_registry_repository_iam_binding.admins](https://registry.terraform.io/providers/hashicorp/google-beta/latest/docs/resources/google_artifact_registry_repository_iam_binding) | resource |
| [google-beta_google_artifact_registry_repository_iam_member.reader_vault](https://registry.terraform.io/providers/hashicorp/google-beta/latest/docs/resources/google_artifact_registry_repository_iam_member) | resource |
| [google_cloud_scheduler_job.builder_nightly](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/cloud_scheduler_job) | resource |
| [google_cloudbuild_trigger.base_updater](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/cloudbuild_trigger) | resource |
| [google_cloudbuild_trigger.containers_pr](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/cloudbuild_trigger) | resource |
| [google_org_policy_policy.allow_service_accounts](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/org_policy_policy) | resource |
| [google_org_policy_policy.allowed_cloud_build_worker_pools](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/org_policy_policy) | resource |
| [google_org_policy_policy.allowed_storage_retention_policy_seconds](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/org_policy_policy) | resource |
| [google_project_iam_member.base_updater_builds](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/project_iam_member) | resource |
| [google_project_iam_member.base_updater_workflows](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/project_iam_member) | resource |
| [google_project_service.service](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/project_service) | resource |
| [google_service_account.base_updater](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/service_account) | resource |
| [google_storage_bucket.trusted_artifacts](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/storage_bucket) | resource |
| [google_storage_bucket_iam_policy.trusted_artifacts](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/storage_bucket_iam_policy) | resource |
| [google_workflows_workflow.base_updater](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/workflows_workflow) | resource |
| [google_iam_policy.trusted_artifacts](https://registry.terraform.io/providers/hashicorp/google/latest/docs/data-sources/iam_policy) | data source |
| [google_project.current](https://registry.terraform.io/providers/hashicorp/google/latest/docs/data-sources/project) | data source |

## Inputs

No inputs.

## Outputs

No outputs.
<!-- END_TF_DOCS -->