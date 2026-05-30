# ---------------------------------------------------------------------------
# Subnet route approval
#
# The Tailscale Kubernetes operator creates Connector resources that deploy
# subnet-router pods which advertise cluster CIDRs.  Those routes must be
# *approved* (enabled) in the admin console before other tailnet members
# will route traffic through them.
#
# The operator can auto-approve routes, but Terraform ownership here acts
# as an idempotent backstop — if a route ever gets un-approved, the
# operator's OAuth client lacks the `routes` scope, or an approval is
# accidentally revoked, we still have coverage.
#
# NOTE: only routes the device is *already advertising* can be enabled
# here; Terraform can *not* make a device start advertising a route.
# The Tailscale operator handles advertisement via the Connector spec.
# ---------------------------------------------------------------------------

locals {
  connector_routes = {
    folly-connector = {
      device_key = "folly-k8s-lan-router-0"
      routes = [
        "10.0.0.0/9",      # Cilium native routing CIDR — covers all folly k8s IPs
        "10.3.0.64/26",    # folly LB range — ArgoCD lives at 10.3.0.70
      ]
    }
    offsite-connector = {
      device_key = "offsite-k8s-lan-router-0"
      routes = [
        "10.89.0.0/28",    # Cilium native routing CIDR
        "10.89.0.64/26",   # offsite LB range
        "192.168.2.0/24",  # offsite LAN
      ]
    }
  }
}

resource "tailscale_device_subnet_routes" "connector" {
  for_each = local.connector_routes

  device_id = data.tailscale_device.devices[each.value.device_key].node_id
  routes    = each.value.routes
}
