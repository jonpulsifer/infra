# Public App names reach the cluster here. The origin is the Apps' own Gateway,
# with its own listeners and address, so App traffic cannot crowd the shared one.
module "tunnel_spindrift" {
  source     = "./modules/tunnel"
  account_id = local.fml_account_id
  zone_id    = cloudflare_zone.lolwtf_dev.id
  name       = "spindrift"
  config = {
    ingress = [
      {
        # Only the bosun outbox, bearer-authed by SPINDRIFT_BOSUN_SECRET. Other paths reach the
        # control plane through the wildcard, and it serves only its machine routes on this host.
        hostname = "spindrift-control.${cloudflare_zone.lolwtf_dev.name}"
        path     = "^/internal/bosun/"
        service  = "http://spindrift.spindrift.svc.cluster.local:3000"
      },
      {
        # The GitHub App webhook, HMAC-authenticated by the App's webhook secret.
        hostname = "spindrift-control.${cloudflare_zone.lolwtf_dev.name}"
        path     = "^/internal/github/webhook$"
        service  = "http://spindrift.spindrift.svc.cluster.local:3000"
      },
      {
        hostname = "*.${cloudflare_zone.lolwtf_dev.name}"
        service  = "http://cilium-gateway-spindrift-apps.spindrift-apps.svc.cluster.local"
      },
      # Wildcard rules only route: the module publishes no record for them, so
      # hand-managed names that point elsewhere never reach this tunnel.
      {
        hostname = "*.${cloudflare_zone.lolwtf_ca.name}"
        service  = "http://cilium-gateway-spindrift-apps.spindrift-apps.svc.cluster.local"
      },
      {
        hostname = "*.${cloudflare_zone.wishin_app.name}"
        service  = "http://cilium-gateway-spindrift-apps.spindrift-apps.svc.cluster.local"
      },
      # The module publishes into lolwtf.dev only; kthx_apex below is this record.
      {
        hostname       = cloudflare_zone.kthx_dev.name
        service        = "http://cilium-gateway-spindrift-apps.spindrift-apps.svc.cluster.local"
        publish_record = false
      },
      {
        hostname = "*.${cloudflare_zone.kthx_dev.name}"
        service  = "http://cilium-gateway-spindrift-apps.spindrift-apps.svc.cluster.local"
      },
      # `*.<zone>` never matches the apex. The App's DNSEndpoint publishes its record.
      {
        hostname       = cloudflare_zone.clankerbanker_ca.name
        service        = "http://cilium-gateway-spindrift-apps.spindrift-apps.svc.cluster.local"
        publish_record = false
      },
      {
        hostname = "*.${cloudflare_zone.clankerbanker_ca.name}"
        service  = "http://cilium-gateway-spindrift-apps.spindrift-apps.svc.cluster.local"
      },
      # No embarrassing.ca rule: Vercel and Cloudflare Pages serve that zone, and
      # no cluster gateway listens for it.
      {
        service = "http_status:404"
      }
    ]
  }
}

# A wildcard is safe here: nothing in this zone is hand-managed. Unserved names reach
# the status route in clusters/offsite/apps/spindrift; exact records outrank this one.
resource "cloudflare_dns_record" "spindrift_apps_wildcard" {
  zone_id = cloudflare_zone.lolwtf_dev.id
  comment = "terraform managed"
  name    = "*.${cloudflare_zone.lolwtf_dev.name}"
  content = module.tunnel_spindrift.cloudflare_tunnel_url
  type    = "CNAME"
  proxied = true
  ttl     = 1
}

# Nothing in kthx.dev is hand-managed either: every name is a site.
resource "cloudflare_dns_record" "kthx_sites_wildcard" {
  zone_id = cloudflare_zone.kthx_dev.id
  comment = "terraform managed"
  name    = "*.${cloudflare_zone.kthx_dev.name}"
  content = module.tunnel_spindrift.cloudflare_tunnel_url
  type    = "CNAME"
  proxied = true
  ttl     = 1
}

# `*.<zone>` never matches the apex, so the landing page gets its own record.
resource "cloudflare_dns_record" "kthx_apex" {
  zone_id = cloudflare_zone.kthx_dev.id
  comment = "terraform managed"
  name    = cloudflare_zone.kthx_dev.name
  content = module.tunnel_spindrift.cloudflare_tunnel_url
  type    = "CNAME"
  proxied = true
  ttl     = 1
}

# External Secrets delivers the tunnel token from 1Password, so no decrypted
# value enters git.
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

# No Access application on this zone: `reach: private` records hold RFC1918
# addresses, and the route's ExternalAuth filter enforces `auth: proxy`.

# The controller mints Workers scripts `fn-*` and custom domains `<name>.fn.lolwtf.dev`
# outside this root; the single-label wildcard above never matches them.
# Its Workers token scopes, set by hand: Account Workers Scripts Edit and Workers Tail
# Read; Zone lolwtf.dev Workers Routes Edit, SSL and Certificates Edit, Zone Read.
