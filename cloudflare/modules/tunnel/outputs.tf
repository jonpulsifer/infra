output "cloudflare_tunnel_id" {
  value = cloudflare_zero_trust_tunnel_cloudflared.this.id
}

output "cloudflare_tunnel_url" {
  value = "${cloudflare_zero_trust_tunnel_cloudflared.this.id}.cfargotunnel.com"
}

output "cloudflare_tunnel_token" {
  sensitive = true
  value     = data.cloudflare_zero_trust_tunnel_cloudflared_token.this.token
}