---
title: Node lifecycle
description: How a folly node goes from a NetBox device to an attested Talos node with a SPIRE identity, and back out, with the system that owns each step.
---

A folly node is a `kubernetes-node` device in [NetBox](netbox.md). The owner starts each run by setting its `desired_action`. [Identity](identity.md#lifecycle) lists the statuses and who writes each.

## At a glance

1. The owner sets the device's `desired_action` to `provision`.
2. [fleet-controller](../apps/fleet-controller.md) creates a `provision` `Workflow` in [Tinkerbell](nixos/tinkerbell.md) and resets `desired_action` to `none`.
3. Rufio powers the node on to a one-time PXE boot. The owner powers on a `planned` or BMC-less device.
4. The signed iPXE chains the signed HookOS, which attests the TPM and boot chain to [talos-attest](../apps/talos-attest.md).
5. On a pass, talos-attest issues an LDevID and a LAK certificate, has fleet-controller render the node's Talos config, and answers an install code wrapped to the TPM.
6. The `Workflow` wipes the system disk, runs the Talos installer with the code in META, and boots the disk.
7. On its first boot, Talos fetches its config by UUID and code from `/talos/config`. The controller deletes the file once nginx serves it whole, and sets the device `active`.
8. When spore has the node's alias, its SPIRE agent attests by the LDevID and serves SVIDs.

A machine NetBox does not know starts the same path itself: HookOS phones home, an attest-only run makes it a `staged` device, and fleet-controller binds it to a stub's name, gives it a class and an address, and sets `desired_action` to `provision`. A provision that installs nothing, such as for the control plane or a TPM 1.2 node, wipes the disk and leaves the node in HookOS. `attest` issues a new LDevID. `wipe` erases the disk with no attestation. The status `decommissioning` starts a `retire` run, which wipes the disk and powers the node off, leaving it `offline`.

## Who owns what

| Component | What it owns | Where it lives |
| --- | --- | --- |
| NetBox | Class, status, `desired_action`, verdicts | capsule |
| fleet-controller | `Hardware`, `Machine`, `Workflow`, the rendered config, retirement | spore |
| talos-attest | Attestation, the LDevID and LAK, install codes, renewal | every anchor |
| [Boot plane](nixos/talos-boot.md) | dnsmasq, nginx, the signed iPXE and HookOS, behind `BOOT_VIP` | every anchor |
| Tinkerbell | Smee, the Tink server and Rufio, which run each `Workflow` | spore |
| [SPIRE](identity.md) | The server, the agents, and `tpm-reattest` | server on spore, agents on the folly nodes |
| [talos-enroll](../apps/talos-enroll.md) | The device flow, which no served image starts, and the `enroll.lolwtf.ca` server | every anchor, and folly |
| [UniFi network](network/routing-and-firewall.md#bootstrap-vlan-and-mac-auth) | MAC auth, and RADIUS users that put a `failed` node on the bootstrap VLAN | `terraform/network/unifi/folly/bootstrap.tf` |

## Trust

- The firmware boots only images signed under the lab's Secure Boot keys, and `apps/talos-attest/policy.yaml` refuses any other boot.
- The LDevID key stays in the TPM. spore's and capsule's DevID CA keys are in a YubiKey, and forge signs with the software CA from `terraform/pki`.
- The running node renews its LDevID with a quote that its LAK signs. A `decommissioning` or `offline` device gets no renewal.

## Where to go next

- [Prepare a machine](../runbooks/prepare-a-machine.md), [Provision a node](../runbooks/provision-a-node.md), [Reprovision a node](../runbooks/reprovision-a-node.md), [Retire a node](../runbooks/retire-a-node.md)
- [Identity](identity.md), [fleet-controller](../apps/fleet-controller.md), [talos-attest](../apps/talos-attest.md), [Tinkerbell](nixos/tinkerbell.md), [NetBox](netbox.md), [Metal dev env](metal-dev.md)
