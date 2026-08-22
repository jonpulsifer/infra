variable "account_id" {
  type        = string
  description = "The account ID to create the tunnel in"
}

variable "zone_id" {
  type        = string
  description = "The zone ID to create the DNS record in"
}

variable "name" {
  type        = string
  description = "The name of the tunnel"
}

variable "config" {
  description = "The config for the tunnel. See https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/zero_trust_tunnel_cloudflared_config"
  type = object({
    ingress = list(object({
      hostname = optional(string)
      # Regex over the request path. A rule with one matches only that slice
      # of its hostname, which is what lets a single path prefix go public
      # without the rest of the origin coming with it.
      path    = optional(string)
      service = string
      # Whether this module publishes the proxied CNAME for the rule's
      # hostname. `false` for a name some other controller publishes — an
      # App's apex, whose record its own DNSEndpoint carries — so the rule is
      # routing only and the zone holds one owner per name.
      publish_record = optional(bool, true)
    }))
  })
  default = {
    ingress = [{
      service = "http_status:418"
    }]
  }
}