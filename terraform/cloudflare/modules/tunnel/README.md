<!-- BEGIN_TF_DOCS -->
## Requirements

| Name | Version |
|------|---------|
| <a name="requirement_cloudflare"></a> [cloudflare](#requirement\_cloudflare) | ~> 5.0 |

## Providers

| Name | Version |
|------|---------|
| <a name="provider_cloudflare"></a> [cloudflare](#provider\_cloudflare) | ~> 5.0 |

## Modules

No modules.

## Resources

| Name | Type |
|------|------|
| [cloudflare_dns_record.cf](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/dns_record) | resource |
| [cloudflare_zero_trust_tunnel_cloudflared.this](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/zero_trust_tunnel_cloudflared) | resource |
| [cloudflare_zero_trust_tunnel_cloudflared_config.this](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/zero_trust_tunnel_cloudflared_config) | resource |
| [cloudflare_zero_trust_tunnel_cloudflared_token.this](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/data-sources/zero_trust_tunnel_cloudflared_token) | data source |

## Inputs

| Name | Description | Type | Default | Required |
|------|-------------|------|---------|:--------:|
| <a name="input_account_id"></a> [account\_id](#input\_account\_id) | The account ID to create the tunnel in | `string` | n/a | yes |
| <a name="input_config"></a> [config](#input\_config) | The config for the tunnel. See https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/zero_trust_tunnel_cloudflared_config | <pre>object({<br/>    ingress = list(object({<br/>      hostname = optional(string)<br/>      service  = string<br/>    }))<br/>  })</pre> | <pre>{<br/>  "ingress": [<br/>    {<br/>      "service": "http_status:418"<br/>    }<br/>  ]<br/>}</pre> | no |
| <a name="input_name"></a> [name](#input\_name) | The name of the tunnel | `string` | n/a | yes |
| <a name="input_zone_id"></a> [zone\_id](#input\_zone\_id) | The zone ID to create the DNS record in | `string` | n/a | yes |

## Outputs

| Name | Description |
|------|-------------|
| <a name="output_cloudflare_tunnel_id"></a> [cloudflare\_tunnel\_id](#output\_cloudflare\_tunnel\_id) | n/a |
| <a name="output_cloudflare_tunnel_token"></a> [cloudflare\_tunnel\_token](#output\_cloudflare\_tunnel\_token) | n/a |
| <a name="output_cloudflare_tunnel_url"></a> [cloudflare\_tunnel\_url](#output\_cloudflare\_tunnel\_url) | n/a |
<!-- END_TF_DOCS -->