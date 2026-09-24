# jonpulsifer

OpenTofu root for the `jonpulsifer` GCP project: its APIs, its IAM policy, a storage bucket and the `dotfiles` source repository. See [Cloud](https://wiki.lolwtf.ca/platform/cloud/) on the wiki.

`google_project_iam_policy.explicit` in `iam.tf` is authoritative. A project binding that this root does not declare is removed on the next apply.

## Develop

```bash
tofu -chdir=terraform/gcp/projects/jonpulsifer init -backend=false
tofu -chdir=terraform/gcp/projects/jonpulsifer validate
TF_DIR=terraform/gcp/projects/jonpulsifer mise run tf:plan
```

A local plan impersonates `terraform@homelab-ng.iam.gserviceaccount.com`, so your Google account needs Service Account Token Creator on it. `mise run tf:docs` regenerates the tables below.

## Deploy

Atlantis plans this root on a pull request that changes it. Comment `atlantis apply` to apply the plan, and a successful apply merges the pull request. State is in `gs://homelab-ng/terraform/jonpulsifer`.

<!-- BEGIN_TF_DOCS -->
## Requirements

| Name | Version |
|------|---------|
| <a name="requirement_terraform"></a> [terraform](#requirement\_terraform) | >= 1.2.5 |
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
| [google_project_iam_policy.explicit](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/project_iam_policy) | resource |
| [google_project_service.project](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/project_service) | resource |
| [google_sourcerepo_repository.dotfiles](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/sourcerepo_repository) | resource |
| [google_storage_bucket.jonpulsifer](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/storage_bucket) | resource |
| [google_storage_bucket_iam_policy.gcs-jonpulsifer](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/storage_bucket_iam_policy) | resource |
| [google_client_config.current](https://registry.terraform.io/providers/hashicorp/google/latest/docs/data-sources/client_config) | data source |
| [google_iam_policy.explicit](https://registry.terraform.io/providers/hashicorp/google/latest/docs/data-sources/iam_policy) | data source |
| [google_iam_policy.gcs-jonpulsifer](https://registry.terraform.io/providers/hashicorp/google/latest/docs/data-sources/iam_policy) | data source |

## Inputs

No inputs.

## Outputs

No outputs.
<!-- END_TF_DOCS -->