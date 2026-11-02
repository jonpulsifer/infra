---
title: fleetd
description: The service on spore that checks machine identity and controls folly node installation.
status: live
---

fleetd controls how a machine becomes a folly Kubernetes node. It runs on spore and uses NetBox for device state and owner requests.

It checks the machine's identity, authorizes installation, and checks the running node each hour. [Tinkerbell](../platform/nixos/tinkerbell.md) runs the installation actions.

## Start here

| To learn about | Read |
| --- | --- |
| The system and its trust boundaries | [Folly design](../reference/folly-design.md) |
| Provision, wipe and retirement requests | [Lifecycle](fleetd/lifecycle.md) |
| Identity checks and configuration delivery | [Attestation and installation](fleetd/attestation.md) |
| Endpoints, alerts and recovery limits | [Operate fleetd](fleetd/operations.md) |

## How it works

1. A machine boots HookOS, the network installation environment.
2. Its Trusted Platform Module (TPM) proves possession of the approved endorsement keys (EKs).
3. fleetd checks the boot evidence and the device's declaration in NetBox.
4. fleetd issues device certificates and authorizes an eligible installation.
5. Tinkerbell wipes the declared disk and installs Talos.
6. Talos fetches its configuration once. fleetd then marks the device `active`.
7. The running node sends a signed boot check each hour.

The device certificates are the Local Device Identity (LDevID) and Local Attestation Key (LAK) certificates. The LAK signs later boot checks.

## Owner actions

The owner sets `desired_action` in NetBox to request `provision`, `attest` or `wipe`. The `decommissioning` status requests retirement.

- [Provision a node](../runbooks/provision-a-node.md): install an eligible machine.
- [Reprovision a node](../runbooks/reprovision-a-node.md): replace an installation.
- [Retire a node](../runbooks/retire-a-node.md): erase the disk and remove the node.

## Important limits

- Provision, wipe and retirement erase data. Each requires the declared disk serial.
- A successful installation Workflow means the reboot starts. It does not prove that Talos boots or Kubernetes becomes ready.
- A spore reboot loses pending configurations. Recovery requires a new provision.
- Retirement cannot revoke an issued kubelet client certificate.
- TPM 1.2 nodes and class `worker-g2` cannot use this installation path.

## Reference

- Source and HTTP contract: `apps/fleetd/`
- Service: `nix/services/fleetd.nix`
- Class declarations: `clusters/folly/fleet/classes.json`
- Kea reservations, one per NetBox device with a MAC: `/var/lib/kea/fleet/reservations.json` on spore ([Kea](../platform/nixos/kea.md#reservations))
- Alerts: `clusters/folly/monitoring/fleetd-rules.yaml`
