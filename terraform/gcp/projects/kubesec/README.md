# kubesec

OpenTofu root for the `kubesec` GCP project, which holds the `cloud-lab` static website bucket. See [Cloud](https://wiki.lolwtf.ca/platform/cloud/) on the wiki.

## Develop

```bash
tofu -chdir=terraform/gcp/projects/kubesec init -backend=false
tofu -chdir=terraform/gcp/projects/kubesec validate
TF_DIR=terraform/gcp/projects/kubesec mise run tf:plan
```

A local plan needs Google credentials with access to the project and the state bucket. `mise run tf:docs` regenerates the tables below.

## Deploy

Atlantis plans this root on a pull request that changes it. Comment `atlantis apply` to apply the plan, and a successful apply merges the pull request. State is in `gs://homelab-ng/terraform/lab`.

<!-- BEGIN_TF_DOCS -->
## Requirements

| Name | Version |
|------|---------|
| <a name="requirement_terraform"></a> [terraform](#requirement\_terraform) | >= 1.1.9 |
| <a name="requirement_google"></a> [google](#requirement\_google) | ~> 7.34.0 |

## Providers

| Name | Version |
|------|---------|
| <a name="provider_google"></a> [google](#provider\_google) | 7.34.0 |

## Modules

No modules.

## Resources

| Name | Type |
|------|------|
| [google_storage_bucket.cloud-lab](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/storage_bucket) | resource |
| [google_storage_bucket_iam_policy.gcs-cloud-lab](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/storage_bucket_iam_policy) | resource |
| [google_iam_policy.gcs-cloud-lab](https://registry.terraform.io/providers/hashicorp/google/latest/docs/data-sources/iam_policy) | data source |

## Inputs

No inputs.

## Outputs

No outputs.
<!-- END_TF_DOCS -->