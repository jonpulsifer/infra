---
title: Node lifecycle
description: How a folly node goes from a NetBox device to an attested Talos node with a SPIRE identity, and back out, with the system that owns each step.
---

A folly node is a `kubernetes-node` device in [NetBox](netbox.md). The switch, the TPM's identity and the boot plane follow the device's `status` and `desired_action`, and the owner starts each run by setting one of them.

## At a glance

1. The owner sets the device's `desired_action` to `provision`.
2. [fleet-controller](../apps/fleet-controller.md) creates a `provision` `Workflow` in [Tinkerbell](nixos/tinkerbell.md), sets `desired_action` back to `none`, and names the run in `last_workflow`.
3. Rufio powers the node on to a one-time PXE boot through its BMC. The owner powers on a `planned` device, or one with no BMC, by hand.
4. The signed iPXE chains the signed HookOS, which attests the TPM and the boot chain to [talos-attest](../apps/talos-attest.md) at the boot VIP.
5. On a pass, talos-attest issues an LDevID and a LAK certificate into the TPM, has fleet-controller render the node's Talos config, and answers an install code wrapped to that TPM.
6. The `Workflow` wipes the system disk, runs the Talos installer with the code in META, and boots the disk.
7. On its first boot, Talos fetches its config by UUID and code from `/talos/config` on the anchors. The controller deletes the file once nginx serves it whole.
8. The controller sets the device `active`. When spore has the node's alias, its SPIRE agent attests by the LDevID and serves SVIDs.

A provision that installs nothing, such as for the control plane or a TPM 1.2 node, wipes the disk and leaves the node in HookOS. `attest` issues a new LDevID and boots the installed disk, and the status stays. `wipe` erases the system disk with no attestation and leaves the node in HookOS. The status `decommissioning` starts a `retire` run, which wipes the disk and powers the node off, and the device becomes `offline`.

## Who owns what

| Component | What it owns | Where it lives |
| --- | --- | --- |
| NetBox | Each machine: class, status, `desired_action`, verdicts | capsule |
| fleet-controller | `Hardware`, `Machine` and `Workflow` objects, the rendered config, retirement | spore |
| talos-attest | Attestation, the LDevID and LAK, install codes, renewal | every anchor |
| [Boot plane](nixos/talos-boot.md) | dnsmasq, nginx, the signed iPXE, HookOS and the release mirror, behind `BOOT_VIP` | every anchor |
| Tinkerbell | Smee, the Tink server and Rufio, which run each `Workflow` and drive the BMC | spore |
| [SPIRE](identity.md) | The server, the agents, and `tpm-reattest` | server on spore, agents on the folly nodes |
| [talos-enroll](../apps/talos-enroll.md) | The device flow of a Talos image with `talos.config.oauth.*` arguments, which no served image carries, and the `enroll.lolwtf.ca` server | every anchor, and folly |
| [UniFi network](network/routing-and-firewall.md#bootstrap-vlan-and-mac-auth) | MAC auth, a RADIUS user per node whose VLAN follows the status, `failed` on bootstrap | `terraform/network/unifi/folly/bootstrap.tf` |

## Lifecycle statuses

| Status | Meaning | Written by |
| --- | --- | --- |
| `planned` | Ordered, serial known | The owner |
| `staged` | Intake, attestation or install in progress | talos-attest on a verdict, fleet-controller on a `provision` or `wipe`, or the owner |
| `active` | Config released, expected Ready | fleet-controller when the node fetches its config, or talos-enroll when it releases one |
| `failed` | Quarantined by attestation | talos-attest |
| `decommissioning` | Retiring | The owner |
| `offline` | Retired, kept for history | fleet-controller, after the `retire` run |

Only the owner moves a device out of `failed` or into `decommissioning`.

## Trust

- The firmware boots only images signed under the lab's Secure Boot keys, and talos-attest's `apps/talos-attest/policy.yaml` refuses any other boot.
- The LDevID key stays in the TPM. spore's and capsule's DevID CAs keep their keys in a YubiKey, and forge signs with the software DevID CA from `terraform/pki`. The subject names the node, its serial, its `talos_class` and the site.
- The running node renews its LDevID with a quote that its LAK signs. A `decommissioning` or `offline` device gets no renewal, so its identity ends at expiry.
- A `failed` node's RADIUS user puts it on the bootstrap VLAN, on a port that runs MAC auth (`mab_enforced` and `spare_ports` in `bootstrap.tf`).

## Where to go next

- [Prepare a machine](../runbooks/prepare-a-machine.md), [Provision a node](../runbooks/provision-a-node.md), [Reprovision a node](../runbooks/reprovision-a-node.md), [Retire a node](../runbooks/retire-a-node.md)
- [Identity](identity.md), [fleet-controller](../apps/fleet-controller.md), [talos-attest](../apps/talos-attest.md), [Tinkerbell](nixos/tinkerbell.md), [NetBox](netbox.md), [Metal dev env](metal-dev.md)
