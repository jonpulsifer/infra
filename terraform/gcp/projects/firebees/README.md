# firebees

OpenTofu root for the `firebees` GCP project: its Firebase project and the project org policy overrides from `terraform/modules/firebase-project-policies`. See [Cloud](https://wiki.lolwtf.ca/platform/cloud/) on the wiki.

## Develop

```bash
tofu -chdir=terraform/gcp/projects/firebees init -backend=false
tofu -chdir=terraform/gcp/projects/firebees validate
TF_DIR=terraform/gcp/projects/firebees mise run tf:plan
```

A local plan impersonates `terraform@homelab-ng.iam.gserviceaccount.com`, so your Google account needs Service Account Token Creator on it. `mise run tf:docs` regenerates the tables below.

## Deploy

Atlantis plans this root on a pull request that changes it. Comment `atlantis apply` to apply the plan, and a successful apply merges the pull request. State is in `gs://homelab-ng/terraform/firebees`.

<!-- BEGIN_TF_DOCS -->
## Requirements

| Name | Version |
|------|---------|
| <a name="requirement_terraform"></a> [terraform](#requirement\_terraform) | >= 1.2.9 |
| <a name="requirement_google"></a> [google](#requirement\_google) | ~> 7.34.0 |
| <a name="requirement_google-beta"></a> [google-beta](#requirement\_google-beta) | ~> 7.34.0 |

## Providers

| Name | Version |
|------|---------|
| <a name="provider_google"></a> [google](#provider\_google) | 7.34.0 |
| <a name="provider_google-beta"></a> [google-beta](#provider\_google-beta) | 7.34.0 |

## Modules

No modules.

## Resources

| Name | Type |
|------|------|
| [google-beta_google_firebase_project.firebees](https://registry.terraform.io/providers/hashicorp/google-beta/latest/docs/resources/google_firebase_project) | resource |
| [google_org_policy_policy.allow_service_account_keys](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/org_policy_policy) | resource |
| [google_org_policy_policy.allow_service_accounts](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/org_policy_policy) | resource |
| [google_org_policy_policy.allowed_storage_retention_policy_seconds](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/org_policy_policy) | resource |

## Inputs

No inputs.

## Outputs

No outputs.
<!-- END_TF_DOCS -->