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
