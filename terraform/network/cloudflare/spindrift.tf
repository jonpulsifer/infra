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

# This is the Target's default Private audience. Public exposure requires a
# more-specific bypass application for the Component hostname; until that
# exists, the wildcard policy fails closed rather than weakening access.
resource "cloudflare_zero_trust_access_application" "spindrift_private" {
  account_id       = local.fml_account_id
  name             = "Spindrift Private Apps"
  domain           = "*.${cloudflare_zone.lolwtf_dev.name}"
  type             = "self_hosted"
  session_duration = "24h"

  policies = [
    {
      name       = "operator"
      decision   = "allow"
      precedence = 1
      include = [
        {
          email = {
            email = "jonathan@pulsifer.ca"
          }
        }
      ]
    }
  ]
}

# OAuth completes on the same parent domain as Spindrift's application
# cookies. The callback must remain reachable before a user has an Access
# session, so this exact hostname bypasses the enclosing wildcard policy.
resource "cloudflare_zero_trust_access_application" "spindrift_oauth_callback" {
  account_id       = local.fml_account_id
  name             = "Spindrift OAuth Callback"
  domain           = "oauth2.${cloudflare_zone.lolwtf_dev.name}"
  type             = "self_hosted"
  session_duration = "24h"

  policies = [
    {
      name       = "OAuth callback"
      decision   = "bypass"
      precedence = 1
      include = [
        {
          everyone = {}
        }
      ]
    }
  ]
}
