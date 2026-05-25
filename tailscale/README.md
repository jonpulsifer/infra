# Tailscale Terraform

This stack manages the `pirate-musical.ts.net` tailnet.

The initial import is represented with Terraform `import` blocks in `imports.tf`.
Run from this directory with access to the GCS backend credentials and the
1Password service account token:

```bash
export OP_SERVICE_ACCOUNT_TOKEN="$(op item get 'Service Account Auth Token: Nixos' --fields=token --vault=ib23znjeikv74p37f6mbfk7uya --reveal)"
terraform init
terraform plan
terraform apply
```

After the first successful apply imports these resources into state, remove
`imports.tf` in a follow-up change.

<!-- BEGIN_TF_DOCS -->
## Requirements

| Name | Version |
|------|---------|
| <a name="requirement_onepassword"></a> [onepassword](#requirement\_onepassword) | ~> 3.0 |
| <a name="requirement_tailscale"></a> [tailscale](#requirement\_tailscale) | ~> 0.29 |

## Providers

| Name | Version |
|------|---------|
| <a name="provider_tailscale"></a> [tailscale](#provider\_tailscale) | 0.29.1 |

## Modules

No modules.

## Resources

| Name | Type |
|------|------|
| [tailscale_acl.this](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/acl) | resource |
| [tailscale_contacts.this](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/contacts) | resource |
| [tailscale_device_authorization.atomic](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_authorization) | resource |
| [tailscale_device_authorization.chromebook_a288](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_authorization) | resource |
| [tailscale_device_authorization.cloudpi4](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_authorization) | resource |
| [tailscale_device_authorization.craftbook_air](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_authorization) | resource |
| [tailscale_device_authorization.desktop_g7i75ls](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_authorization) | resource |
| [tailscale_device_authorization.device_800g2](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_authorization) | resource |
| [tailscale_device_authorization.folly_k8s_lan_router_0](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_authorization) | resource |
| [tailscale_device_authorization.folly_k8s_lan_router_0_npazfyuw](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_authorization) | resource |
| [tailscale_device_authorization.homepi4](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_authorization) | resource |
| [tailscale_device_authorization.localhost](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_authorization) | resource |
| [tailscale_device_authorization.nuc](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_authorization) | resource |
| [tailscale_device_authorization.offsite_k8s_lan_router_0](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_authorization) | resource |
| [tailscale_device_authorization.oldboy](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_authorization) | resource |
| [tailscale_device_authorization.oldschool](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_authorization) | resource |
| [tailscale_device_authorization.optiplex](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_authorization) | resource |
| [tailscale_device_authorization.retrofit](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_authorization) | resource |
| [tailscale_device_authorization.riptide](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_authorization) | resource |
| [tailscale_device_authorization.rosie](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_authorization) | resource |
| [tailscale_device_authorization.spore](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_authorization) | resource |
| [tailscale_device_authorization.tailscale_operator](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_authorization) | resource |
| [tailscale_device_authorization.tailscale_operator_nmzwhs8h](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_authorization) | resource |
| [tailscale_device_authorization.tailscale_operator_ntmt4w6m](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_authorization) | resource |
| [tailscale_device_authorization.tallboy](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_authorization) | resource |
| [tailscale_device_authorization.tinytower](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_authorization) | resource |
| [tailscale_device_authorization.weatherpi4](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_authorization) | resource |
| [tailscale_device_key.atomic](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_key) | resource |
| [tailscale_device_key.chromebook_a288](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_key) | resource |
| [tailscale_device_key.cloudpi4](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_key) | resource |
| [tailscale_device_key.craftbook_air](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_key) | resource |
| [tailscale_device_key.desktop_g7i75ls](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_key) | resource |
| [tailscale_device_key.device_800g2](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_key) | resource |
| [tailscale_device_key.folly_k8s_lan_router_0](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_key) | resource |
| [tailscale_device_key.folly_k8s_lan_router_0_npazfyuw](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_key) | resource |
| [tailscale_device_key.homepi4](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_key) | resource |
| [tailscale_device_key.localhost](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_key) | resource |
| [tailscale_device_key.nuc](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_key) | resource |
| [tailscale_device_key.offsite_k8s_lan_router_0](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_key) | resource |
| [tailscale_device_key.oldboy](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_key) | resource |
| [tailscale_device_key.oldschool](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_key) | resource |
| [tailscale_device_key.optiplex](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_key) | resource |
| [tailscale_device_key.retrofit](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_key) | resource |
| [tailscale_device_key.riptide](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_key) | resource |
| [tailscale_device_key.rosie](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_key) | resource |
| [tailscale_device_key.spore](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_key) | resource |
| [tailscale_device_key.tailscale_operator](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_key) | resource |
| [tailscale_device_key.tailscale_operator_nmzwhs8h](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_key) | resource |
| [tailscale_device_key.tailscale_operator_ntmt4w6m](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_key) | resource |
| [tailscale_device_key.tallboy](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_key) | resource |
| [tailscale_device_key.tinytower](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_key) | resource |
| [tailscale_device_key.weatherpi4](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_key) | resource |
| [tailscale_device_tags.desktop_g7i75ls](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_tags) | resource |
| [tailscale_device_tags.device_800g2](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_tags) | resource |
| [tailscale_device_tags.folly_k8s_lan_router_0](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_tags) | resource |
| [tailscale_device_tags.folly_k8s_lan_router_0_npazfyuw](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_tags) | resource |
| [tailscale_device_tags.nuc](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_tags) | resource |
| [tailscale_device_tags.offsite_k8s_lan_router_0](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_tags) | resource |
| [tailscale_device_tags.oldschool](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_tags) | resource |
| [tailscale_device_tags.optiplex](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_tags) | resource |
| [tailscale_device_tags.retrofit](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_tags) | resource |
| [tailscale_device_tags.riptide](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_tags) | resource |
| [tailscale_device_tags.spore](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_tags) | resource |
| [tailscale_device_tags.tailscale_operator](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_tags) | resource |
| [tailscale_device_tags.tailscale_operator_nmzwhs8h](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_tags) | resource |
| [tailscale_device_tags.tailscale_operator_ntmt4w6m](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_tags) | resource |
| [tailscale_dns_configuration.this](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/dns_configuration) | resource |
| [tailscale_tailnet_settings.this](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/tailnet_settings) | resource |

## Inputs

No inputs.

## Outputs

No outputs.
<!-- END_TF_DOCS -->