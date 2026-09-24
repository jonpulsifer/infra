# tailscale

OpenTofu root for the Tailscale tailnet: its settings, DNS, access policy, device authorization and tags, the GitHub Actions identity, and OAuth clients. See [Remote access](https://wiki.lolwtf.ca/platform/network/remote-access/) on the wiki.

`fleet.tf.json` names the tailnet and the public DNS zone, and `nix/lib/fleet.nix` reads the same file. `policy.hujson` is the access policy.

## Develop

```bash
tofu -chdir=terraform/network/tailscale init -backend=false
tofu -chdir=terraform/network/tailscale validate
TF_DIR=terraform/network/tailscale mise run tf:plan
```

A local plan needs Google credentials for the state bucket and `OP_SERVICE_ACCOUNT_TOKEN`, which the Tailscale provider uses to read its OAuth client from 1Password. `mise run tf:docs` regenerates the tables below.

## Deploy

Atlantis plans this root on a pull request that changes it. Comment `atlantis apply` to apply the plan, and a successful apply merges the pull request. State is in `gs://homelab-ng/terraform/tailscale`.

A change to `policy.hujson` alone also autoplans, because the Atlantis autoplan file list includes `terraform/**/*.hujson`.

<!-- BEGIN_TF_DOCS -->
## Requirements

| Name | Version |
| ---- | ------- |
| <a name="requirement_onepassword"></a> [onepassword](#requirement\_onepassword) | ~> 3.0 |
| <a name="requirement_tailscale"></a> [tailscale](#requirement\_tailscale) | ~> 0.29 |

## Providers

| Name | Version |
| ---- | ------- |
| <a name="provider_onepassword"></a> [onepassword](#provider\_onepassword) | 3.3.1 |
| <a name="provider_tailscale"></a> [tailscale](#provider\_tailscale) | 0.29.2 |

## Modules

No modules.

## Resources

| Name | Type |
| ---- | ---- |
| [onepassword_item.forge_tailscale_oauth](https://registry.terraform.io/providers/1password/onepassword/latest/docs/resources/item) | resource |
| [tailscale_acl.this](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/acl) | resource |
| [tailscale_contacts.this](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/contacts) | resource |
| [tailscale_device_authorization.devices](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_authorization) | resource |
| [tailscale_device_key.devices](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_key) | resource |
| [tailscale_device_tags.devices](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_tags) | resource |
| [tailscale_dns_configuration.this](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/dns_configuration) | resource |
| [tailscale_federated_identity.github_actions_nixos_deploy](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/federated_identity) | resource |
| [tailscale_oauth_client.forge_enrollment](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/oauth_client) | resource |
| [tailscale_tailnet_settings.this](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/tailnet_settings) | resource |
| [tailscale_device.devices](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/data-sources/device) | data source |

## Inputs

No inputs.

## Outputs

| Name | Description |
| ---- | ----------- |
| <a name="output_github_actions_nixos_deploy_audience"></a> [github\_actions\_nixos\_deploy\_audience](#output\_github\_actions\_nixos\_deploy\_audience) | Set as the TS\_OIDC\_AUDIENCE repository variable. |
| <a name="output_github_actions_nixos_deploy_client_id"></a> [github\_actions\_nixos\_deploy\_client\_id](#output\_github\_actions\_nixos\_deploy\_client\_id) | Set as the TS\_OIDC\_CLIENT\_ID repository variable (not a secret — access is gated by the OIDC issuer/subject check, not by knowledge of this id). |
<!-- END_TF_DOCS -->
