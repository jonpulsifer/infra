---
title: Operate fleetd
description: Access, alerts and recovery limits for fleetd.
---

fleetd exposes device, administration and monitoring endpoints. Use this page to identify access requirements, alerts and recovery limits.

## Access

| Surface | Address | Who can reach it |
| --- | --- | --- |
| Device flow | `https://enroll.lolwtf.ca/attest/v1/attest` and the session routes under it | HookOS on a netbooting machine, at spore's bootstrap address |
| Install config | `https://enroll.lolwtf.ca/talos/config?uuid=<uuid>&code=<code>` | A node's first boot from disk |
| LDevID and verdict lookups, renewal and daily check | `http://<SPORE_IP>:8444/devid/<serial>`, `/verdict/<serial>`, `POST /v1/renew` | folly's `K8S_NODE_CIDR` and `CILIUM_POD_CIDR` |
| Webhook and metrics | `http://<SPORE_IP>:8446/webhook`, `/healthz`, `/metrics` | NetBox's event rule and the Anchor network |
| Admin API | `https://spore.<tailnet>:8445`, `GET /machines` | Tailnet logins in `ATTEST_APPROVERS` |
| NetBox | A device's `desired_action` and `status` | The owner |

`SPORE_IP` and `SPORE_BOOTSTRAP_IP` are in `clusters/folly/config/anchor-topology.json`. The anchors' CoreDNS answers the enrollment name with spore's bootstrap address, and a public certificate covers it, since Talos trusts only its bundled roots before it has a config.


## Trust in the machine

An approved EK binding depends on independent evidence: a receiving scan or supplier record that ties the chassis serial to its keys. A reported serial, pending claim or unchecked console cannot establish that binding.

TPM 1.2 nodes and class `worker-g2` cannot attest or install through fleetd.

One issuer signs new LDevIDs. The bundle `terraform/pki/certs/folly-devid-ca.pem` also trusts capsule's and forge's software CAs. LDevIDs from those issuers remain accepted until their nodes renew through spore.

## Lost configurations

Configurations contain cluster secrets. They stay in tmpfs at `/run/fleetd/configs`, outside persistent disk storage.

A fleetd restart preserves this directory. A spore reboot loses it, including served-config records without a NetBox release. Existing Workflows continue; fleetd does not automatically provision again.

If an installed node requests a lost configuration, its device stays `planned`. fleetd journals the first request and raises `FleetInstallConfigMissing` while requests continue. Recovery requires the owner to request `provision` again.

## Consumed configurations

A node can acknowledge its configuration and lose power before Talos writes it to STATE. Its next request uses a consumed code.

fleetd never serves a configuration twice. The code is a bearer credential, visible in META and on the console.

fleetd journals the first repeat request and raises `FleetInstallConfigRefetched` while requests continue, regardless of device status. Recovery requires a new provision. In this case, the disk contains no STATE to preserve.

## Boot completion

A Workflow's `SUCCESS` means the reboot starts. It does not prove that the disk boots.

If firmware selects PXE first, the node can return to HookOS with its configuration unread. fleetd journals this once per run and raises `FleetNodeBootedHookOSAfterInstall`.

An explicit `desired_action` can require a network boot. That expected boot does not count as a failure.

## Kubernetes credentials

A worker configuration contains a token for that node alone. fleetd approves only the matching node's first kubelet certificate. The controller manager approves no bootstrap requests.

fleetd deletes the token one minute after approval. Until then, anyone holding the configuration can join as that node.

A cluster-wide bootstrap token requires the owner's approval, including for shale and control planes. fleetd journals the request. Follow [Install Talos on a node](../../runbooks/install-talos-on-a-node.md#approve-the-nodes-first-certificate).

A copied cluster-wide token remains usable until [Rotate the cluster bootstrap token](../../runbooks/rotate-the-cluster-bootstrap-token.md) replaces it.

A worker cannot bootstrap with an expired per-node token. If its kubelet certificate is lost or expires after a year offline, recovery requires a new provision. Wiping `EPHEMERAL` can cause this loss.

## Credentials after retirement

Kubelet client certificates cannot be revoked. A disk image can retain a certificate valid for up to a year and register the Node again. fleetd can delete the Node and bootstrap token, but cannot invalidate that certificate.

Every Talos configuration also contains the cluster's trustd token, `machine.token`. Nothing rotates this token. A copy on disk can still obtain Talos API certificates.

## Disk identity

The disk check trusts the serial that the disk reports. Duplicate serials cause refusal, including clones and some USB bridges. A disk without a serial exposed through sysfs cannot be wiped or installed through fleetd.

## Alerts

| Alert | Meaning | Runbook |
| --- | --- | --- |
| `EnrollmentNameNotServed` | fleetd is down, or its certificate lapsed | [Provision a node](../../runbooks/provision-a-node.md#if-something-goes-wrong) |
| `FleetdDevIDNotServing` | The DevID listener on 8444, which every renewal reaches, does not answer | Read `journalctl -u fleetd` on spore |
| `TalosAttestUnattendedBootFailed` | A node booted HookOS unprompted and failed attestation; nothing was recorded | Read the device's NetBox journal |
| `BootFilesNotServed` | dnsmasq or nginx on spore does not serve iPXE or HookOS | [Provision a node](../../runbooks/provision-a-node.md#if-something-goes-wrong) |
| `FleetInstallPending` | A rendered config has waited 30 minutes for its node | [Provision a node](../../runbooks/provision-a-node.md#if-something-goes-wrong) |
| `FleetInstallConfigMissing` | A planned device's node asks for a config fleetd does not hold, as after a reboot of spore | [Provision a node](../../runbooks/provision-a-node.md#if-something-goes-wrong) |
| `FleetInstallConfigRefetched` | A node asks again for a config fleetd served it and did not keep it | [Provision a node](../../runbooks/provision-a-node.md#if-something-goes-wrong) |
| `FleetNodeBootedHookOSAfterInstall` | A planned device attested from HookOS after its provision succeeded, so its firmware did not boot the disk | [Provision a node](../../runbooks/provision-a-node.md#if-something-goes-wrong) |
| `TalosAttestQuarantined` | A node's newest verdict is a quarantine | [Provision a node](../../runbooks/provision-a-node.md#if-something-goes-wrong) |
| `TalosAttestWaitingForApproval` | An intake waits for an approved EK binding | [Provision a node](../../runbooks/provision-a-node.md#approve-a-machines-eks) |
| `TalosAttestNotChecked`, `TalosAttestLDevIDExpiring` | A node's daily quote or renewal fails | [Add a TPM node to SPIRE](../../runbooks/add-a-tpm-node-to-spire.md#if-something-goes-wrong) |
| `TalosAttestCheckFailed`, `TalosAttestPCR0Changed` | A daily check failed, or PCR 0 moved at one BIOS version | Read the device's NetBox journal |
| `KubeletCSRPending` | A kubelet's first certificate request has waited an hour | [Install Talos on a node](../../runbooks/install-talos-on-a-node.md#approve-the-nodes-first-certificate) |
| `NodeClientApprovalBindingRestored` | The controller manager's approval binding has subjects again, as after a Talos Kubernetes upgrade, or fleetd cannot read it | Reconcile Flux's `tinkerbell-access` |

## Related

- [fleetd overview](../fleetd.md)
