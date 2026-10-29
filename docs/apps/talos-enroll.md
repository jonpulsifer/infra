---
title: Talos enrollment
description: A Go service that answers the OAuth device flow of a Talos machine and releases its config once the owner approves it. No served image starts that flow now. It runs on the folly cluster and on the three anchors.
status: live
---

talos-enroll is the enrollment server for folly's Talos nodes. A machine that starts the OAuth device flow asks it for a device code, waits for the owner's approval, and then fetches its machine config.

No served image starts that flow. The release (`.github/scripts/talos-images-build.sh`) builds no netboot UKI, `talos-installer-verify.sh` refuses `talos.config.oauth.*` arguments in the installer, and the iPXE menu in `nix/images/ipxe-folly.nix` has no install item. [fleet-controller](fleet-controller.md) installs and releases each node's config. The service still runs, and its `enroll.lolwtf.ca` server also carries `/talos/config`, which nginx passes to fleet-controller on spore (`nix/services/fleet-controller.nix`, `nix/services/talos-enroll.nix`).

It runs in two places. Each [anchor](../platform/nixos/talos-boot.md) runs a copy behind `BOOT_VIP`, and the anchors' CoreDNS answers `enroll.lolwtf.ca` with `BOOT_VIP`, so a machine on the bootstrap VLAN enrolls through the anchors. The public name still resolves to the cluster's copy at `ENROLL_VIP`, which no machine on the bootstrap VLAN asks for.

## Use it

| Surface | Address | Who can reach it |
| --- | --- | --- |
| Device flow | `https://enroll.lolwtf.ca`, paths `/device/code`, `/token` and `/config` | The bootstrap VLAN, at `BOOT_VIP` through the anchors' DNS; clients that route to `ENROLL_VIP` reach the cluster's copy |
| Approval page and API | `https://talos-enroll.<tailnet>`; on an anchor, `https://<anchor>.<tailnet>:8443` | Tailnet logins in `ENROLL_APPROVERS` |
| Prompts | The Discord channel of the Alertmanager webhook | Members of that channel |

Each machine gets one Discord message, which the server edits as its enrollment moves on. The prompt and the console's QR code name the approval page of the server that holds the code. `mise run enroll:approve <code> <node>`, `enroll:deny <uuid>` and `enroll:pending` call the anchors' approval API. Only the anchor that holds `BOOT_VIP` knows a code, so `scripts/enroll.sh` tries each anchor and moves on while one answers 404. `ENROLL_ADMIN_URL` names one server. [Provision a node](../runbooks/provision-a-node.md) is the procedure.

The user code shows only on the machine's console, so an approval proves that the approver read the console of the machine being enrolled.

NetBox is the directory of nodes. Each anchor's copy looks a device request up by the serial it claims, in the site's `kubernetes-node` devices, and reads the device's class, install disk, address, TPM and lifecycle. A staged worker whose `attest_verdict` is `attested`, whose `attest_consumed_at` is unset or earlier than `last_attested`, and whose `last_attested` is within `ENROLL_AUTO_APPROVE_WINDOW`, is approved as that device with no click when the request's MAC is the device's and [talos-attest](talos-attest.md)'s verdict names the request's UUID and the device. The server writes `attest_consumed_at` to NetBox before it issues the token, so one attestation approves one request, on any anchor; a write that fails refuses the approval. A control plane is approved only by a click. Its Discord note says it was auto-approved after attestation. Any other request waits for a click, and its prompt says why. A config release, click or not, spends any earlier attestation and marks a `planned` or `staged` device `active`; it never resurrects a retired one, and a click on a `decommissioning` or `offline` device is refused. While NetBox does not answer, the inventory export `clusters/folly/inventory/machines.yaml` is the directory, with no attestation, so every approval is a click. The cluster's copy has no directory and renders nothing. `apps/talos-enroll/README.md` has the field contract.

## Limits

- A device code lasts 15 minutes and a token 30 minutes. A token releases one config.
- State is in memory. A restart, or a move of `BOOT_VIP` to another anchor, forgets every enrollment and denial, and Talos starts a new device flow.
- The machine's UUID, MAC, serial and hostname are unverified claims. The token is bound to the UUID, and the console's user code is the only check against a request in another machine's name.
- Auto-approval trusts the request's serial and MAC. Until the release spends the attestation in NetBox, a host that knows a just-attested machine's serial and MAC can claim that machine's config.
- The anchors hold the worker subset of the secrets bundle once `scripts/talos-worker-secrets.sh` has sealed it and dropped the bundle. A control-plane approval then answers 409: the control plane is installed through the `clusters/folly/talos/` root.

## How it works

A machine that starts the flow uses client `talos-enroll` at `enroll.lolwtf.ca`. On approval, the server renders the node's config with `talosctl gen config --with-secrets` from its class's entry in `clusters/folly/apps/talos-enroll/class-inputs.json`, the node's own facts from the directory, and the worker subset of the 1Password note `talos-folly-secrets`, as the `clusters/folly/talos/` root does for a node of that class. `mise run render-class-inputs` writes the class file from the root's `classes`; a new node changes it not at all. A worker is rendered from a throwaway bundle and its six secrets are swapped in afterwards, so the anchors hold no cluster CA key.

Talos trusts only its bundled roots before it has a config, so the name has a Let's Encrypt certificate. On the cluster, a Gateway serves it and the approval listener's NetworkPolicy admits only the tailnet Ingress. On each anchor, `nix/services/talos-enroll.nix` gets the certificate over DNS-01, nginx serves the three routes at `BOOT_VIP`, and `tailscale serve` passes the approval page to a socket that only root can open. Both proxies set `Tailscale-User-Login`, which the approver check trusts. sops-nix holds the bundle, the webhook and the DNS token in each anchor's `nix/secrets/<anchor>.sops.yaml`.

## Operate

| Alert | Meaning |
| --- | --- |
| `TalosEnrollmentWaiting` | A machine has asked for device codes for 30 minutes with no approval or denial |
| `TalosEnrollmentConfigNotFetched` | An approved machine has fetched no config for 10 minutes |
| `TalosEnrolledNodeNotReady` | A node fetched its config 30 minutes ago and is not Ready |
| `AnchorEnrollVipDown`, `AnchorEnrollNotServing` | No anchor, or one anchor, serves enrollment ([Talos boot](../platform/nixos/talos-boot.md#alerts)) |

The first three read the anchors' copies. Each anchor's `talos-enroll-check` timer writes the server's `/metrics` into its node exporter's textfile collector, so the series carry the anchor's `instance`. Only the anchor that holds `BOOT_VIP` has codes, and the others read zero. After a change to `clusters/folly/talos/`, run `mise run render-class-inputs` and commit the class file in the same pull request. Every decision is one JSON log line with an `event` of `enroll.request`, `enroll.approve`, `enroll.release` or `enroll.deny`.

## Reference

- Source, HTTP contract and Nix package: `apps/talos-enroll/`
- Manifests: `clusters/folly/apps/talos-enroll/`
- Anchors: `nix/services/talos-enroll.nix`
- Alerts: `clusters/folly/monitoring/talos-enroll-rules.yaml`, `clusters/folly/monitoring/anchor-vips.yaml`
- Image: `ghcr.io/jonpulsifer/talos-enroll`
