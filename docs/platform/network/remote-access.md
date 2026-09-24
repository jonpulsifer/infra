---
title: Remote access
description: The Tailscale tailnet that reaches both sites' private addresses, and the grants that decide who reaches what.
---

Remote access is a Tailscale tailnet, a private network that joins devices over WireGuard. The owner uses it to reach both sites' private addresses from off the LAN. CI uses it only to SSH to the `tag:pi4` devices.

A tag is a label on a tailnet device. A grant in the tailnet policy lets a user or tag reach a set of addresses. OpenTofu declares the tailnet, and Atlantis, the service that runs OpenTofu on a PR, applies it.

## Parts

| Part | Job | Where it runs |
| --- | --- | --- |
| Connector | Routes tailnet traffic into the site. It advertises the site's LAN networks, `K8S_NODE_CIDR` and `LB_RANGE`. | One in each cluster |
| `policy.hujson` | Decides which users and tags reach which addresses, and approves the Connectors' routes | Tailscale, applied by Atlantis |
| `devices.tf` | Authorizes each device, sets its key expiry and assigns its tags | Tailscale, applied by Atlantis |
| CI identity | Lets the `nixos-deploy` workflow join as `tag:ci` with a GitHub OIDC token | GitHub Actions |
| forge OAuth client | Enrolls forge as `tag:lab-host` | forge |

The Kubernetes node hosts run no Tailscale client (`nix/system/tailscale-disable.nix`), so tailnet traffic reaches each site through its Connector. folly's LAN networks are Management and Lab Net, and offsite's is Default.

OpenTofu escrows the forge client's secret in 1Password. After the Atlantis apply, the operator copies it into forge's SOPS file as `tailscale-auth-key`.

## Grants

| Source | Reaches |
| --- | --- |
| The owner | Every tagged device, the owner's own devices, both sites' LAN networks, the `offsite-bell` subnet, and both clusters' node subnets and load-balancer addresses (VIPs) |
| Every tailnet member | `tag:kthx-ingress`, the [kthx](../../apps/kthx.md) tailnet Ingress, on TCP port 443 |
| `tag:folly` | offsite's node subnet, VIPs and Default network |
| `tag:offsite` | folly's node subnet and VIPs |
| `tag:ci` | `tag:pi4` devices on TCP port 22 |

Every member can also use Tailscale SSH on their own devices, after a fresh sign-in check.

The Connectors carry `tag:k8s`, `tag:k8s-<site>`, and `tag:folly` or `tag:offsite`. `autoApprovers` accepts routes from `tag:k8s-folly` and `tag:k8s-offsite` without review. `devices.tf` also gives `tag:folly` to spore and nuc, and `tag:offsite` to desktop-g7i75ls, so the cross-site grants cover those devices too. It also tags optiplex, riptide, oldschool and retrofit, which run no Tailscale client.

## Rules

- The CI identity accepts only `nixos-deploy.yaml` runs on `main`. A run from another branch cannot join the tailnet.
- The tailnet requires device approval. After a new device joins, add it to `devices.tf`. Until Atlantis applies the entry, the device waits for approval.
- `policy.hujson` holds literal subnets, because HuJSON, the policy's JSON-with-comments format, has no variables. After a topology change, edit its `autoApprovers`, `ipsets` and `tests`. A stale `autoApprovers` leaves new routes waiting for approval, stale `ipsets` make the grants deny the new range, and stale `tests` fail the policy apply.

## Where it lives

- `terraform/network/tailscale/`: the tailnet settings in `main.tf`, the policy in `policy.hujson`, the device map in `devices.tf`, the CI identity in `github_actions.tf` and the forge client in `oauth_clients.tf`
- `terraform/network/tailscale/fleet.tf.json`: the tailnet name
- `clusters/base/networking/tailscale/`: the `tailscale-operator` HelmRelease
- `clusters/<site>/networking/tailscale-connectors/`: each site's Connector
- `nix/hosts/forge.nix`: forge's `tailscale-auth-key` secret

## Related

- [Network](../network.md)
- [Deploy a NixOS host](../../runbooks/deploy-a-nixos-host.md)
