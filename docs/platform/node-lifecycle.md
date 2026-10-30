---
title: Node lifecycle
description: How a folly node goes from a NetBox device to an attested Talos node with a SPIRE identity, and back out, with the system that owns each step.
---

A folly node is an entry in `clusters/folly/inventory/nodes.yaml`, which `terraform/netbox/folly` applies into [NetBox](netbox.md) as a `kubernetes-node` device. The owner starts each run by setting its `desired_action`. [Identity](identity.md#lifecycle) lists the statuses and who writes each, and [Hardware inventory](../reference/inventory.md) the nodes file.

## At a glance

1. The owner adds the node's entry to the nodes file in a pull request, and Atlantis applies it: a `planned` device with its serial, class, address and cable, and no MAC.
2. The owner sets the device's `desired_action` to `provision`.
3. [fleet-controller](../apps/fleet-controller.md) creates a `provision` `Workflow` in [Tinkerbell](nixos/tinkerbell.md) and resets `desired_action` to `none`.
4. Rufio powers the node on through its BMC, AMT at the node's own address, to a one-time PXE boot on the Kubernetes network. The owner powers on a BMC-less device.
5. The signed iPXE chains the signed HookOS, which attests the TPM and boot chain to [talos-attest](../apps/talos-attest.md), and talos-attest writes the MAC on the device with the machine's serial.
6. On a pass, talos-attest issues an LDevID and a LAK certificate, has fleet-controller render the node's Talos config, and answers an install code wrapped to the TPM.
7. The `Workflow` wipes the system disk, runs the Talos installer with the code in META, and boots the disk.
8. On its first boot, Talos fetches its config by UUID and code from `/talos/config`, and takes the node's address statically from it. The controller deletes the file once nginx serves it whole, and sets the device `active`.
9. When spore has the node's alias, its SPIRE agent attests by the LDevID and serves SVIDs.

A machine whose serial no entry names starts the same path itself: HookOS phones home, an attest-only run, once the owner approves its first intake, makes it a `planned` device, and fleet-controller binds it to a stub's name, gives it a class and an address, and sets `desired_action` to `provision`. A provision that installs nothing, such as for the control plane or a TPM 1.2 node, wipes the disk and leaves the node in HookOS. `attest` issues a new LDevID. `wipe` erases the disk with no attestation. The status `decommissioning` starts a `retire` run, which wipes the disk and powers the node off, leaving it `offline`.

## Who owns what

| Component | What it owns | Where it lives |
| --- | --- | --- |
| Nodes file | Each node's name, serial, model, class, switch port, address and BMC type | `clusters/folly/inventory/nodes.yaml` |
| `terraform/netbox/folly` | The device, its address and cable, its declared custom fields, the custom field definitions, the fleet-controller webhook | Atlantis on offsite |
| NetBox | Status, `desired_action`, verdicts, MACs | capsule |
| fleet-controller | `Hardware`, `Machine`, `Workflow`, the rendered config, retirement | spore |
| talos-attest | Attestation, the LDevID and LAK, install codes, renewal | every anchor |
| [Boot plane](nixos/talos-boot.md) | dnsmasq, nginx, the signed iPXE and HookOS, and the `enroll.lolwtf.ca` HTTPS server, behind `BOOT_VIP` | every anchor |
| Tinkerbell | Smee, the Tink server and Rufio, which run each `Workflow` | spore |
| [SPIRE](identity.md) | The server, the agents, and `tpm-reattest` | server on spore, agents on the folly nodes |
| [UniFi network](network/routing-and-firewall.md#node-ports) | Node ports, each the Kubernetes network untagged, and that network's DHCP pool for netbooting machines | `terraform/network/unifi/folly/bootstrap.tf`, `k8s.tf` |

## Trust

- The firmware boots only images signed under the lab's Secure Boot keys, and `apps/talos-attest/policy.yaml` refuses any other boot.
- The LDevID key stays in the TPM. spore's and capsule's DevID CA keys are in a YubiKey, and forge signs with the software CA from `terraform/pki`.
- The running node renews its LDevID with a quote that its LAK signs. A `decommissioning` or `offline` device gets no renewal.
- A quote that misses the policy quarantines a worker: talos-attest revokes its identity, and fleet-controller cordons it. A control plane is only alerted on. [Identity](identity.md) has the rules.

## Where to go next

- [Prepare a machine](../runbooks/prepare-a-machine.md), [Provision a node](../runbooks/provision-a-node.md), [Reprovision a node](../runbooks/reprovision-a-node.md), [Retire a node](../runbooks/retire-a-node.md)
- [Identity](identity.md), [fleet-controller](../apps/fleet-controller.md), [talos-attest](../apps/talos-attest.md), [Tinkerbell](nixos/tinkerbell.md), [NetBox](netbox.md)
