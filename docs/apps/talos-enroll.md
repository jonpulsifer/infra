---
title: Talos enrollment
description: A Go service that answers the OAuth device flow of a Talos machine booted from the network, and releases the machine's config once the owner approves it. It runs on the folly cluster and on the three anchors.
status: unverified
---

talos-enroll is the enrollment server for folly's Talos nodes. A machine that network boots the signed Talos image asks it for a device code, waits for the owner's approval, and then fetches its machine config. No machine has enrolled through it yet.

It runs in two places. Each [anchor](../platform/nixos/talos-boot.md) runs a copy behind `BOOT_VIP`, and the anchors' CoreDNS answers `enroll.lolwtf.ca` with `BOOT_VIP`, so a machine on the bootstrap VLAN enrolls through the anchors. The public name still resolves to the cluster's copy at `ENROLL_VIP`, which no machine on the bootstrap VLAN asks for.

## Use it

| Surface | Address | Who can reach it |
| --- | --- | --- |
| Device flow | `https://enroll.lolwtf.ca`, paths `/device/code`, `/token` and `/config` | The bootstrap VLAN, at `BOOT_VIP` through the anchors' DNS; clients that route to `ENROLL_VIP` reach the cluster's copy |
| Approval page and API | `https://talos-enroll.<tailnet>`; on an anchor, `https://<anchor>.<tailnet>:8443` | Tailnet logins in `ENROLL_APPROVERS` |
| Prompts | The Discord channel of the Alertmanager webhook | Members of that channel |

Each machine gets one Discord message, which the server edits as its enrollment moves on. The prompt and the console's QR code name the approval page of the server that holds the code. `mise run enroll:approve <code> <node>`, `enroll:deny <uuid>` and `enroll:pending` call the anchors' approval API. Only the anchor that holds `BOOT_VIP` knows a code, so `scripts/enroll.sh` tries each anchor and moves on while one answers 404. `ENROLL_ADMIN_URL` names one server. [Enroll a Talos node](../runbooks/enroll-a-talos-node.md) is the procedure.

The user code shows only on the machine's console, so an approval proves that the approver read the console of the machine being enrolled.

## Limits

- A device code lasts 15 minutes and a token 30 minutes. A token releases one config.
- State is in memory. A restart, or a move of `BOOT_VIP` to another anchor, forgets every enrollment and denial, and Talos starts a new device flow.
- The machine's UUID, MAC, serial and hostname are unverified claims. The token is bound to the UUID, and the console's user code is the only check against a request in another machine's name.
- A node whose installer image comes from the Image Factory resource is unknown without state, so `machine-inputs.json` leaves it out.

## How it works

The netboot UKI carries `talos.config` and the `talos.config.oauth.*` arguments for `enroll.lolwtf.ca`, with client `talos-enroll`. On approval, the server renders the node's config with `talosctl gen config --with-secrets`, the 1Password note `talos-folly-secrets` and the node's entry in `clusters/folly/apps/talos-enroll/machine-inputs.json`, as the `clusters/folly/talos/` root does. `mise run render-machine-inputs` writes that file.

Talos trusts only its bundled roots before it has a config, so the name has a Let's Encrypt certificate. On the cluster, a Gateway serves it and the approval listener's NetworkPolicy admits only the tailnet Ingress. On each anchor, `nix/services/talos-enroll.nix` gets the certificate over DNS-01, nginx serves the three routes at `BOOT_VIP`, and `tailscale serve` passes the approval page to a socket that only root can open. Both proxies set `Tailscale-User-Login`, which the approver check trusts. sops-nix holds the bundle, the webhook and the DNS token in each anchor's `nix/secrets/<anchor>.sops.yaml`.

## Operate

| Alert | Meaning |
| --- | --- |
| `TalosEnrollmentWaiting` | A machine has asked for device codes for 30 minutes with no approval or denial |
| `TalosEnrollmentConfigNotFetched` | An approved machine has fetched no config for 10 minutes |
| `TalosEnrolledNodeNotReady` | A node fetched its config 30 minutes ago and is not Ready |
| `AnchorEnrollVipDown`, `AnchorEnrollNotServing` | No anchor, or one anchor, serves enrollment ([Talos boot](../platform/nixos/talos-boot.md#alerts)) |

The first three read the anchors' copies. Each anchor's `talos-enroll-check` timer writes the server's `/metrics` into its node exporter's textfile collector, so the series carry the anchor's `instance`. Only the anchor that holds `BOOT_VIP` has codes, and the others read zero. After a change to `clusters/folly/talos/`, run `mise run render-machine-inputs` and commit both files in the same pull request.

## Reference

- Source, HTTP contract and Nix package: `apps/talos-enroll/`
- Manifests: `clusters/folly/apps/talos-enroll/`
- Anchors: `nix/services/talos-enroll.nix`
- Alerts: `clusters/folly/monitoring/talos-enroll-rules.yaml`, `clusters/folly/monitoring/anchor-vips.yaml`
- Image: `ghcr.io/jonpulsifer/talos-enroll`
