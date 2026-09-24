---
title: Remote access
description: The Tailscale tailnet that reaches both sites' private addresses, and the grants that decide who reaches what.
---

Remote access is a Tailscale tailnet that the owner uses to reach both sites' private addresses from off the LAN. OpenTofu declares the tailnet, and Atlantis applies it.

## Parts

| Part | Job | Where it runs |
| --- | --- | --- |
| Connector | Routes tailnet traffic into the site, and advertises its LAN networks, `K8S_NODE_CIDR` and `LB_RANGE` | One in each cluster |
| `policy.hujson` | Holds the grants, and approves the Connectors' routes | Tailscale |
| `devices.tf` | Authorizes each device, sets its key expiry and assigns its tags | Tailscale |
| CI identity | Lets the `nixos-deploy` workflow join as `tag:ci` with a GitHub OIDC token | GitHub Actions |
| forge OAuth client | Enrolls forge as `tag:lab-host` | forge |

The Kubernetes nodes run no Tailscale client (`nix/system/tailscale-disable.nix`), so tailnet traffic reaches each site through its Connector. folly's LAN networks are Management and Lab Net, and offsite's is Default.

OpenTofu stores the forge client's secret in 1Password. After the Atlantis apply, copy it into forge's SOPS file as `tailscale-auth-key`.

## Grants

| Source | Reaches |
| --- | --- |
| The owner | Every tagged device, the owner's own devices, both sites' LAN networks, the `offsite-bell` subnet, and both clusters' node subnets and load-balancer addresses (VIPs) |
| Every tailnet member | `tag:kthx-ingress`, the [kthx](../../apps/kthx.md) tailnet Ingress, on TCP port 443, and Tailscale SSH to their own devices after a fresh sign-in check |
| `tag:folly` | offsite's node subnet, VIPs and Default network |
| `tag:offsite` | folly's node subnet and VIPs |
| `tag:ci` | `tag:pi4` devices on TCP port 22 |

The Connectors carry `tag:k8s`, `tag:k8s-<site>`, and `tag:folly` or `tag:offsite`. `autoApprovers` accepts routes from `tag:k8s-folly` and `tag:k8s-offsite` without review. `devices.tf` also gives `tag:folly` to spore and nuc, and `tag:offsite` to desktop-g7i75ls. No host sheet covers nuc or desktop-g7i75ls. `offsite-bell` is an `ipset` in `policy.hujson`, and no UniFi root declares its subnet.

## Rules

- The CI identity accepts only `nixos-deploy.yaml` runs on `main`.
- The tailnet requires device approval. A new device waits until Atlantis applies its entry in `devices.tf`.
- `policy.hujson` holds literal subnets. After a topology change, edit its `autoApprovers`, `ipsets` and `tests`. Otherwise new routes wait for approval, the grants deny the new range, and the policy apply fails.

## Where it lives

- `terraform/network/tailscale/`: the tailnet settings, policy and device map, the CI identity in `github_actions.tf` and the forge client in `oauth_clients.tf`
- `terraform/network/tailscale/fleet.tf.json`: the tailnet name
- `clusters/base/networking/tailscale/`: the `tailscale-operator` HelmRelease
- `clusters/<site>/networking/tailscale-connectors/`: each site's Connector
- `nix/hosts/forge.nix`: forge's `tailscale-auth-key` secret

## Related

- [Network](../network.md)
- [Deploy a NixOS host](../../runbooks/deploy-a-nixos-host.md)
