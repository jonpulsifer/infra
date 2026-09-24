# trusted-builds

OpenTofu root for `trusted-builds`, the GCP project that builds, signs and stores kthx artifacts for every vessel. See [kthx security](https://wiki.lolwtf.ca/apps/kthx/security/) on the wiki.

`supply-chain.tf` calls `terraform/modules/spindrift-supply-chain` for the KMS signing key, the Binary Authorization attestor and their grants. `locals.tf` declares who may sign, verify, read and write. The root also holds the Artifact Registry repository, the Developer Connect link to GitHub and the build seal key. A new Developer Connect connection needs the one-time step in [Authorize Developer Connect](https://wiki.lolwtf.ca/runbooks/authorize-developer-connect/).

`supply-chain.tf` imports the live KMS key ring and key. Keep their names. GCP never deletes a ring or a key, so a new name is a new signing key whose public key the admission policy does not pin.

## Develop

```bash
tofu -chdir=terraform/gcp/projects/trusted-builds init -backend=false
tofu -chdir=terraform/gcp/projects/trusted-builds validate
TF_DIR=terraform/gcp/projects/trusted-builds mise run tf:plan
```

A local plan impersonates `terraform@homelab-ng.iam.gserviceaccount.com`, so your Google account needs Service Account Token Creator on it. `mise run tf:docs` regenerates the tables below.

## Deploy

Atlantis plans this root on a pull request that changes it. Comment `atlantis apply` to apply the plan, and a successful apply merges the pull request. State is in `gs://homelab-ng/terraform/trusted-builds`.

After an apply, copy the `supply_chain_manifest_block` output into the kthx installation manifest. If the attestor ID changes, update it in `terraform/gcp/projects/bluenose/vessel.tf`.

<!-- BEGIN_TF_DOCS -->
## Requirements

| Name | Version |
| ---- | ------- |
| <a name="requirement_terraform"></a> [terraform](#requirement\_terraform) | >= 1.3.3 |
| <a name="requirement_google"></a> [google](#requirement\_google) | ~> 7.44.0 |
| <a name="requirement_google-beta"></a> [google-beta](#requirement\_google-beta) | ~> 7.44.0 |

## Providers

| Name | Version |
| ---- | ------- |
| <a name="provider_google"></a> [google](#provider\_google) | 7.44.0 |
| <a name="provider_google-beta"></a> [google-beta](#provider\_google-beta) | 7.44.0 |

## Modules

| Name | Source | Version |
| ---- | ------ | ------- |
| <a name="module_supply_chain"></a> [supply\_chain](#module\_supply\_chain) | ../../../modules/spindrift-supply-chain | n/a |

## Resources

| Name | Type |
| ---- | ---- |
| [google-beta_google_project_service_identity.developer_connect](https://registry.terraform.io/providers/hashicorp/google-beta/latest/docs/resources/google_project_service_identity) | resource |
| [google_artifact_registry_repository.images](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/artifact_registry_repository) | resource |
| [google_artifact_registry_repository_iam_binding.admins](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/artifact_registry_repository_iam_binding) | resource |
| [google_artifact_registry_repository_iam_member.reader_vault](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/artifact_registry_repository_iam_member) | resource |
| [google_developer_connect_connection.github](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/developer_connect_connection) | resource |
| [google_developer_connect_git_repository_link.infra](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/developer_connect_git_repository_link) | resource |
| [google_org_policy_policy.allow_service_accounts](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/org_policy_policy) | resource |
| [google_org_policy_policy.allowed_cloud_build_worker_pools](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/org_policy_policy) | resource |
| [google_org_policy_policy.allowed_storage_retention_policy_seconds](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/org_policy_policy) | resource |
| [google_project_iam_member.developer_connect_secret_admin](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/project_iam_member) | resource |
| [google_project_service.service](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/project_service) | resource |
| [google_storage_bucket.trusted_artifacts](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/storage_bucket) | resource |
| [google_storage_bucket_iam_policy.trusted_artifacts](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/storage_bucket_iam_policy) | resource |
| [google_iam_policy.trusted_artifacts](https://registry.terraform.io/providers/hashicorp/google/latest/docs/data-sources/iam_policy) | data source |
| [google_project.bluenose](https://registry.terraform.io/providers/hashicorp/google/latest/docs/data-sources/project) | data source |
| [google_project.current](https://registry.terraform.io/providers/hashicorp/google/latest/docs/data-sources/project) | data source |

## Inputs

No inputs.

## Outputs

| Name | Description |
| ---- | ----------- |
| <a name="output_attestor"></a> [attestor](#output\_attestor) | Binary Authorization attestor id (projects/*/attestors/*) the bluenose vessel root's attestor variable takes. |
| <a name="output_infra_git_repository_link"></a> [infra\_git\_repository\_link](#output\_infra\_git\_repository\_link) | The infra repo's Developer Connect link (projects/*/locations/*/connections/*/gitRepositoryLinks/*), what a Cloud Build trigger's developer\_connect\_event\_config takes. |
| <a name="output_supply_chain_manifest_block"></a> [supply\_chain\_manifest\_block](#output\_supply\_chain\_manifest\_block) | The installation manifest's supplyChain block: signer key uri and registry namespace. |
<!-- END_TF_DOCS -->