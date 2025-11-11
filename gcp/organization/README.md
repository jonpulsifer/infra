<!-- BEGIN_TF_DOCS -->
## Requirements

| Name | Version |
|------|---------|
| <a name="requirement_terraform"></a> [terraform](#requirement\_terraform) | >= 1.8.3 |
| <a name="requirement_google"></a> [google](#requirement\_google) | ~> 7.10 |
| <a name="requirement_google-beta"></a> [google-beta](#requirement\_google-beta) | ~> 7.10 |

## Providers

| Name | Version |
|------|---------|
| <a name="provider_google"></a> [google](#provider\_google) | 7.11.0 |

## Modules

| Name | Source | Version |
|------|--------|---------|
| <a name="module_cloud-glue"></a> [cloud-glue](#module\_cloud-glue) | ./modules/project | n/a |
| <a name="module_firebees"></a> [firebees](#module\_firebees) | ./modules/project | n/a |
| <a name="module_homelab-ng"></a> [homelab-ng](#module\_homelab-ng) | ./modules/project | n/a |
| <a name="module_jonpulsifer"></a> [jonpulsifer](#module\_jonpulsifer) | ./modules/project | n/a |
| <a name="module_kubesec"></a> [kubesec](#module\_kubesec) | ./modules/project | n/a |
| <a name="module_lolcorp"></a> [lolcorp](#module\_lolcorp) | ./modules/project | n/a |
| <a name="module_secure-the-cloud"></a> [secure-the-cloud](#module\_secure-the-cloud) | ./modules/project | n/a |
| <a name="module_trusted-builds"></a> [trusted-builds](#module\_trusted-builds) | ./modules/project | n/a |
| <a name="module_wishin_app"></a> [wishin\_app](#module\_wishin\_app) | ./modules/project | n/a |

## Resources

| Name | Type |
|------|------|
| [google_folder.dev](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/folder) | resource |
| [google_folder.hidden](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/folder) | resource |
| [google_folder.production](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/folder) | resource |
| [google_org_policy_policy.gcp_restrictCmekCryptoKeyProjects_dev](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/org_policy_policy) | resource |
| [google_org_policy_policy.gcp_restrictCmekCryptoKeyProjects_production](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/org_policy_policy) | resource |
| [google_org_policy_policy.iam_serviceAccountKeyExpiryHours](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/org_policy_policy) | resource |
| [google_organization_iam_custom_role.read_only_vault](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/organization_iam_custom_role) | resource |
| [google_organization_iam_policy.organization](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/organization_iam_policy) | resource |
| [google_billing_account.cloudlab](https://registry.terraform.io/providers/hashicorp/google/latest/docs/data-sources/billing_account) | data source |
| [google_iam_policy.org](https://registry.terraform.io/providers/hashicorp/google/latest/docs/data-sources/iam_policy) | data source |
| [google_organization.org](https://registry.terraform.io/providers/hashicorp/google/latest/docs/data-sources/organization) | data source |

## Inputs

No inputs.

## Outputs

No outputs.
<!-- END_TF_DOCS -->