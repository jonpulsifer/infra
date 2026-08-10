# trusted-builds

`trusted-builds` is the artifacts project every Spindrift vessel's supply
chain runs through: a KMS key signs, a Binary Authorization attestor checks
admission against the signature, and an Artifact Registry repository
(`artifact-registry.tf`) stages what Cloud Run pulls. The chain itself is
`terraform/modules/spindrift-supply-chain`, called from `supply-chain.tf`;
the principal lists it takes — who signs, who verifies, who reads and writes
the repository — are declared as locals in `locals.tf` so an operator reading
the root sees who may sign without chasing the module. `outputs.tf` hands the
attestor id to the bluenose vessel root and the signer/registry pair to the
installation manifest's `supplyChain` block.

A ring named `keys` holding a key named `signer` is live in this project and
in no state file, its only version `DESTROY_SCHEDULED`. GCP never deletes a
ring or a key, so both names are spent — `supply-chain.tf` names the ring
`spindrift` instead and lets the module create it, the key, and the first
version. Reading the public half of a version that was generated moments ago
can fail once with `PENDING_GENERATION`; the second apply converges, and the
module README says so.

<!-- BEGIN_TF_DOCS -->
## Requirements

| Name | Version |
| ---- | ------- |
| <a name="requirement_terraform"></a> [terraform](#requirement\_terraform) | >= 1.3.3 |
| <a name="requirement_google"></a> [google](#requirement\_google) | ~> 7.43.0 |

## Providers

| Name | Version |
| ---- | ------- |
| <a name="provider_google"></a> [google](#provider\_google) | 7.43.0 |

## Modules

| Name | Source | Version |
| ---- | ------ | ------- |
| <a name="module_supply_chain"></a> [supply\_chain](#module\_supply\_chain) | ../../../modules/spindrift-supply-chain | n/a |

## Resources

| Name | Type |
| ---- | ---- |
| [google_artifact_registry_repository.images](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/artifact_registry_repository) | resource |
| [google_artifact_registry_repository_iam_binding.admins](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/artifact_registry_repository_iam_binding) | resource |
| [google_artifact_registry_repository_iam_member.reader_vault](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/artifact_registry_repository_iam_member) | resource |
| [google_org_policy_policy.allow_service_accounts](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/org_policy_policy) | resource |
| [google_org_policy_policy.allowed_cloud_build_worker_pools](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/org_policy_policy) | resource |
| [google_org_policy_policy.allowed_storage_retention_policy_seconds](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/org_policy_policy) | resource |
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
| <a name="output_supply_chain_manifest_block"></a> [supply\_chain\_manifest\_block](#output\_supply\_chain\_manifest\_block) | The installation manifest's supplyChain block: signer key uri and registry namespace. |
<!-- END_TF_DOCS -->