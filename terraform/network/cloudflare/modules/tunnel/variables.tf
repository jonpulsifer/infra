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
    }))
  })
  default = {
    ingress = [{
      service = "http_status:418"
    }]
  }
}