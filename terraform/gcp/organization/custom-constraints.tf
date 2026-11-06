# Custom org policy constraints. A constraint is defined once at the organization, and a
# google_org_policy_policy on a project or folder enforces it.

# Ingress firewall rules that allow SSH or RDP may source only from Identity-Aware Proxy's TCP
# forwarding range or from a private range. GKE's auto-created rules source from the pod and
# node ranges, so they pass. containsFirewallPort is range-aware and also matches tcp with no
# ports, so a rule cannot hide 22 in 1-65535 or in an open protocol. The constraint evaluates
# the resulting rule on UPDATE too, so an existing public SSH rule can only be deleted.
resource "google_org_policy_custom_constraint" "firewall_ssh_rdp_ingress" {
  name           = "custom.firewallSshRdpIngressFromIapOnly"
  parent         = data.google_organization.org.name
  display_name   = "SSH and RDP ingress only from IAP or private ranges"
  description    = "Ingress firewall rules that allow tcp 22, tcp 3389 or all protocols must source only from 35.235.240.0/20 (IAP TCP forwarding) or RFC 1918 ranges."
  action_type    = "DENY"
  method_types   = ["CREATE", "UPDATE"]
  resource_types = ["compute.googleapis.com/Firewall"]
  condition = join(" ", [
    "resource.direction != 'EGRESS'",
    "&& (resource.allowed.containsFirewallPort('tcp', '22') || resource.allowed.containsFirewallPort('tcp', '3389') || resource.allowed.exists(a, a.IPProtocol == 'all'))",
    "&& !resource.sourceRanges.all(r, r == '35.235.240.0/20' || r.startsWith('10.') || r.startsWith('192.168.') || r.matches('^172\\\\.(1[6-9]|2[0-9]|3[01])\\\\.'))",
  ])
}
