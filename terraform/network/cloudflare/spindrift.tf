# How a `reach: public` App name arrives at the cluster. The origin is the
# Apps' own Gateway service, not the cluster's shared one: App traffic gets its
# own Envoy listener set and its own load-balancer address, so a public App
# cannot crowd the edge the media stack or the operator UI answer on.
module "tunnel_spindrift" {
  source     = "./modules/tunnel"
  account_id = local.fml_account_id
  zone_id    = cloudflare_zone.lolwtf_dev.id
  name       = "spindrift"
  config = {
    ingress = [
      {
        hostname = "*.${cloudflare_zone.lolwtf_dev.name}"
        service  = "http://cilium-gateway-spindrift-apps.spindrift-apps.svc.cluster.local"
      },
      {
        service = "http_status:404"
      }
    ]
  }
}

# Atlantis already authenticates this root to 1Password. Escrow the generated
# tunnel credential directly into the homelab vault so External Secrets can
# deliver it to offsite without a decrypted value entering git.
resource "onepassword_item" "spindrift_cloudflared" {
  vault    = local.vault_id
  title    = "spindrift cloudflared"
  category = "password"

  password_wo = module.tunnel_spindrift.cloudflare_tunnel_token
  # Rotate the write-only field whenever Cloudflare issues a different token.
  password_wo_version = parseint(
    substr(sha256(module.tunnel_spindrift.cloudflare_tunnel_token), 0, 7),
    16,
  )

  tags = [
    "cloudflare",
    "kubernetes",
    "spindrift",
  ]
}

# Access carries no application over this zone. A Component states its own
# audience: `reach: private` publishes an RFC1918 address, so the record type
# is the boundary and no policy has to hold it, and `auth: proxy` is enforced
# in-cluster by the ExternalAuth filter on the route. An Access application
# over the whole zone would add a second prompt in front of the first for a
# Component that already authenticates, and hold nothing closed for one that
# deliberately does not.
