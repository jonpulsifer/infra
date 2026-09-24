# cloudflare

OpenTofu root for the lab's Cloudflare account. See [Ingress and DNS](https://wiki.lolwtf.ca/platform/network/ingress-and-dns/) on the wiki.

Each zone has its own file with its DNS records, settings and rules. The root also declares the Cloudflare Tunnels through `modules/tunnel/`, the Pages projects that serve the wiki and the OIDC issuer, and account lists. `topology.tf` reads each cluster's `cluster-topology.json`.

## Develop

```bash
tofu -chdir=terraform/network/cloudflare init -backend=false
tofu -chdir=terraform/network/cloudflare validate
TF_DIR=terraform/network/cloudflare mise run tf:plan
```

A local plan needs Google credentials for the state bucket and `OP_SERVICE_ACCOUNT_TOKEN`, which the providers use to read their tokens from 1Password. `mise run tf:docs` regenerates the tables below.

## Deploy

Atlantis plans this root on a pull request that changes it. Comment `atlantis apply` to apply the plan, and a successful apply merges the pull request. State is in `gs://homelab-ng/terraform/cloudflare`.

<!-- BEGIN_TF_DOCS -->
## Requirements

| Name | Version |
|------|---------|
| <a name="requirement_cloudflare"></a> [cloudflare](#requirement\_cloudflare) | ~> 5.1 |
| <a name="requirement_github"></a> [github](#requirement\_github) | ~> 6.0 |
| <a name="requirement_null"></a> [null](#requirement\_null) | ~> 3.3.0 |
| <a name="requirement_onepassword"></a> [onepassword](#requirement\_onepassword) | ~> 3.0 |

## Providers

| Name | Version |
|------|---------|
| <a name="provider_cloudflare"></a> [cloudflare](#provider\_cloudflare) | 5.19.1 |
| <a name="provider_github"></a> [github](#provider\_github) | 6.12.1 |

## Modules

| Name | Source | Version |
|------|--------|---------|
| <a name="module_tunnel_folly"></a> [tunnel\_folly](#module\_tunnel\_folly) | ./modules/tunnel | n/a |
| <a name="module_tunnel_offsite"></a> [tunnel\_offsite](#module\_tunnel\_offsite) | ./modules/tunnel | n/a |

## Resources

| Name | Type |
|------|------|
| [cloudflare_dns_record.bbq_pulsifer_ca](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/dns_record) | resource |
| [cloudflare_dns_record.bitcoin](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/dns_record) | resource |
| [cloudflare_dns_record.mx_pulsifer_ca](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/dns_record) | resource |
| [cloudflare_dns_record.pulsifer_ca](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/dns_record) | resource |
| [cloudflare_dns_record.wishin_app](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/dns_record) | resource |
| [cloudflare_dns_record.www_pulsifer_ca](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/dns_record) | resource |
| [cloudflare_dns_record.www_wishin_app](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/dns_record) | resource |
| [cloudflare_list.github_webhook_addresses](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/list) | resource |
| [cloudflare_zone.lolwtf_ca](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/zone) | resource |
| [cloudflare_zone.pulsifer_ca](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/zone) | resource |
| [cloudflare_zone.wishin_app](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/zone) | resource |
| [cloudflare_zone_dnssec.pulsifer_ca_dnssec](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/zone_dnssec) | resource |
| [cloudflare_zone_setting.pulsifer_ca](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/zone_setting) | resource |
| [cloudflare_zone_setting.wishin_app](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/zone_setting) | resource |
| [cloudflare_account.fml](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/data-sources/account) | data source |
| [github_ip_ranges.this](https://registry.terraform.io/providers/integrations/github/latest/docs/data-sources/ip_ranges) | data source |

## Inputs

No inputs.

## Outputs

| Name | Description |
|------|-------------|
| <a name="output_cloudflare_tunnel_token_folly"></a> [cloudflare\_tunnel\_token\_folly](#output\_cloudflare\_tunnel\_token\_folly) | n/a |
| <a name="output_cloudflare_tunnel_token_offsite"></a> [cloudflare\_tunnel\_token\_offsite](#output\_cloudflare\_tunnel\_token\_offsite) | n/a |
<!-- END_TF_DOCS -->