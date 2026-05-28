# Tailscale Terraform

This stack manages the `pirate-musical.ts.net` tailnet.

Run from this directory with access to the GCS backend credentials and the
1Password service account token:

```bash
export OP_SERVICE_ACCOUNT_TOKEN="$(op item get 'Service Account Auth Token: Nixos' --fields=token --vault=ib23znjeikv74p37f6mbfk7uya --reveal)"
terraform init
terraform plan
terraform apply
```

<!-- BEGIN_TF_DOCS -->
## Requirements

| Name | Version |
|------|---------|
| <a name="requirement_onepassword"></a> [onepassword](#requirement\_onepassword) | ~> 3.0 |
| <a name="requirement_tailscale"></a> [tailscale](#requirement\_tailscale) | ~> 0.29 |

## Providers

| Name | Version |
|------|---------|
| <a name="provider_tailscale"></a> [tailscale](#provider\_tailscale) | 0.29.2 |

## Modules

No modules.

## Resources

| Name | Type |
|------|------|
| [tailscale_acl.this](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/acl) | resource |
| [tailscale_contacts.this](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/contacts) | resource |
| [tailscale_device_authorization.devices](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_authorization) | resource |
| [tailscale_device_key.devices](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_key) | resource |
| [tailscale_device_tags.devices](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/device_tags) | resource |
| [tailscale_dns_configuration.this](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/dns_configuration) | resource |
| [tailscale_tailnet_settings.this](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/resources/tailnet_settings) | resource |
| [tailscale_device.devices](https://registry.terraform.io/providers/tailscale/tailscale/latest/docs/data-sources/device) | data source |

## Inputs

No inputs.

## Outputs

No outputs.
<!-- END_TF_DOCS -->
