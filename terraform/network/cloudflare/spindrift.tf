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
        # The bosun outbox, and only it. tender long-polls this path from
        # GCE — the control plane's own hostname is a LAN record a cloud
        # host cannot reach — bearer-authed by SPINDRIFT_BOSUN_SECRET.
        # Path-scoped so the session-authed rest of the control plane stays
        # off the internet; everything else on this hostname falls through
        # to the wildcard and 404s at the Apps gateway.
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
      # The other two zones a `reach: public` App can be minted in. A wildcard
      # ingress rule is routing and nothing else: the module publishes no record
      # for one (see its `cloudflare_dns_record.cf`), so only a name some other
      # controller has pointed at this tunnel ever arrives here. That is what
      # makes a catch-all over the hand-managed zone safe — `wiki`, `tf` and
      # `folly` are records aimed elsewhere and never reach this tunnel.
      {
        hostname = "*.${cloudflare_zone.lolwtf_ca.name}"
        service  = "http://cilium-gateway-spindrift-apps.spindrift-apps.svc.cluster.local"
      },
      {
        hostname = "*.${cloudflare_zone.wishin_app.name}"
        service  = "http://cilium-gateway-spindrift-apps.spindrift-apps.svc.cluster.local"
      },
      {
        hostname = "*.${cloudflare_zone.kthx_dev.name}"
        service  = "http://cilium-gateway-spindrift-apps.spindrift-apps.svc.cluster.local"
      },
      # A cluster-served apex. `*.<zone>` never matches the zone itself, so the
      # apex is its own rule; the record is the App's vanity `@`, which
      # Spindrift's DNSEndpoint publishes, so this rule publishes none.
      {
        hostname       = cloudflare_zone.clankerbanker_ca.name
        service        = "http://cilium-gateway-spindrift-apps.spindrift-apps.svc.cluster.local"
        publish_record = false
      },
      {
        hostname = "*.${cloudflare_zone.clankerbanker_ca.name}"
        service  = "http://cilium-gateway-spindrift-apps.spindrift-apps.svc.cluster.local"
      },
      # No rule for embarrassing.ca: the manifest serves that zone off Vercel
      # and Cloudflare Pages, which are their own edge. A rule here would
      # forward it to a cluster gateway holding no listener for it.
      {
        service = "http_status:404"
      }
    ]
  }
}

# Every name in the zone dedicated to generated App names, pointed at the
# tunnel.
#
# The module publishes no record for a wildcard ingress rule and is right not
# to for the zones it shares with hand-managed names — see its
# `cloudflare_dns_record.cf`. This zone is the one exception, and the reason is
# that the objection does not hold here: the control plane holds a
# lowest-precedence route over `*.lolwtf.dev`
# (`clusters/offsite/apps/spindrift/status-route.yaml`), so a name nothing
# serves reaches a page that says so rather than a bare 404, and an App's
# address answers from the moment the App exists rather than from its first
# successful deploy. A Component that is serving takes the name back at the
# gateway, where its own exact-hostname route outranks the wildcard.
#
# Nothing in this zone is hand-managed, so a catch-all here can only ever
# answer for a name Spindrift itself would mint. `spindrift-control` keeps its
# own record above it: an exact name outranks a wildcard in DNS as it does at
# the gateway.
resource "cloudflare_dns_record" "spindrift_apps_wildcard" {
  zone_id = cloudflare_zone.lolwtf_dev.id
  comment = "terraform managed"
  name    = "*.${cloudflare_zone.lolwtf_dev.name}"
  content = module.tunnel_spindrift.cloudflare_tunnel_url
  type    = "CNAME"
  proxied = true
  ttl     = 1
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

# Spindrift's Functions own a second family of names in this zone, minted by
# the platform controller itself rather than by this root: Workers scripts
# named `fn-*` and Workers custom domains `<name>.fn.lolwtf.dev`. The
# wildcard CNAME above answers single-label names only — `*.lolwtf.dev` —
# so a two-label custom domain under `fn.` never resolves through it and can
# never collide with `spindrift_apps_wildcard`. The custom-domain record
# itself is a Cloudflare-owned side effect of the Workers custom-domain API:
# nothing here declares it, and this root manages none of it.
#
# The controller reaches these APIs with the installation's existing
# Workers-scoped bearer (`cloudflareToken` in
# apps/spindrift/src/adapters/registry.ts), never a DNS credential. The
# operator widens that token's scopes by hand to cover them:
#   Account           → Workers Scripts Edit, Workers Tail Read
#   Zone (lolwtf.dev) → Workers Routes Edit, SSL and Certificates Edit, Zone Read
