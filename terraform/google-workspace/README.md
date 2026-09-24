# google-workspace

OpenTofu root for the `pulsifer.ca` Google Workspace: the domain and its `pulsifer.dev` alias, the users, and the `cloud` group. See [Cloud](https://wiki.lolwtf.ca/platform/cloud/) on the wiki.

## Develop

```bash
tofu -chdir=terraform/google-workspace init -backend=false
tofu -chdir=terraform/google-workspace validate
TF_DIR=terraform/google-workspace mise run tf:plan
```

Outside Atlantis, the providers impersonate `terraform@homelab-ng.iam.gserviceaccount.com`, so your Google account needs Service Account Token Creator on it. The 1Password provider reads `OP_SERVICE_ACCOUNT_TOKEN`. `mise run tf:docs` regenerates the tables below.

## Deploy

Atlantis plans this root on a pull request that changes it. Comment `atlantis apply` to apply the plan, and a successful apply merges the pull request. State is in `gs://homelab-ng/terraform/workspace`.

<!-- BEGIN_TF_DOCS -->
## Requirements

| Name | Version |
|------|---------|
| <a name="requirement_google"></a> [google](#requirement\_google) | ~> 7.0 |
| <a name="requirement_googleworkspace"></a> [googleworkspace](#requirement\_googleworkspace) | ~> 0.7 |
| <a name="requirement_onepassword"></a> [onepassword](#requirement\_onepassword) | ~> 3.0 |

## Providers

| Name | Version |
|------|---------|
| <a name="provider_googleworkspace"></a> [googleworkspace](#provider\_googleworkspace) | 0.7.0 |
| <a name="provider_onepassword"></a> [onepassword](#provider\_onepassword) | 3.3.1 |

## Modules

No modules.

## Resources

| Name | Type |
|------|------|
| [googleworkspace_domain.pulsifer_ca](https://registry.terraform.io/providers/hashicorp/googleworkspace/latest/docs/resources/domain) | resource |
| [googleworkspace_domain_alias.pulsifer_dev](https://registry.terraform.io/providers/hashicorp/googleworkspace/latest/docs/resources/domain_alias) | resource |
| [googleworkspace_group.cloud](https://registry.terraform.io/providers/hashicorp/googleworkspace/latest/docs/resources/group) | resource |
| [googleworkspace_group_members.cloud](https://registry.terraform.io/providers/hashicorp/googleworkspace/latest/docs/resources/group_members) | resource |
| [googleworkspace_group_settings.cloud](https://registry.terraform.io/providers/hashicorp/googleworkspace/latest/docs/resources/group_settings) | resource |
| [googleworkspace_user.agent](https://registry.terraform.io/providers/hashicorp/googleworkspace/latest/docs/resources/user) | resource |
| [googleworkspace_user.me](https://registry.terraform.io/providers/hashicorp/googleworkspace/latest/docs/resources/user) | resource |
| [googleworkspace_user.terraform](https://registry.terraform.io/providers/hashicorp/googleworkspace/latest/docs/resources/user) | resource |
| [onepassword_item.google_workspace_agent_user](https://registry.terraform.io/providers/1password/onepassword/latest/docs/data-sources/item) | data source |

## Inputs

No inputs.

## Outputs

No outputs.
<!-- END_TF_DOCS -->