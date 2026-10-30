---
title: Node lifecycle
description: How a folly node goes from a NetBox device to an attested Talos node with a SPIRE identity, and back out, with the system that owns each step.
---

A folly node is an entry in `clusters/folly/inventory/nodes.yaml`, which `terraform/netbox/folly` applies into [NetBox](netbox.md) as a `kubernetes-node` device. [fleetd](../apps/fleetd.md) on spore attests it and drives each run. [Identity](identity.md#lifecycle) lists the statuses and who writes each, and [Hardware inventory](../reference/inventory.md) the nodes file.

## At a glance

1. The owner adds the node's entry to the nodes file in a pull request, and Atlantis applies it: a `planned` device with its serial, class, address and cable, and no MAC.
2. The owner plugs the machine into its node port. Firmware PXE on the Kubernetes network loads the signed iPXE from spore, which chains the signed HookOS.
3. HookOS attests the TPM and boot chain to fleetd before its agent waits for work, and fleetd writes the MAC on the device with the machine's serial. A device whose entry approves no EK, and a serial no entry names, wait: only a TPM that proves every EK its entry approves gets an identity.
4. On a pass, fleetd issues an LDevID and a LAK certificate. The signed confirm admits the device: fleetd checks its attested switch port, starts its `provision` `Workflow` in [Tinkerbell](nixos/tinkerbell.md), renders its Talos config, and answers an install code wrapped to the TPM.
5. The `Workflow` wipes the system disk, runs the Talos installer with the code in META, and boots the disk.
6. On its first boot, Talos fetches its config by UUID and code from `/talos/config`, and takes the node's address statically from it. fleetd drops the config once it is served whole, and sets the device `active`.
7. When spore has the node's alias, its SPIRE agent attests by the LDevID and serves SVIDs.

An installed node reinstalls when the owner sets `desired_action` to `provision`: fleetd starts the run, Rufio powers the node into HookOS through AMT at its own address, and HookOS's attestation takes the code. A provision that installs nothing, such as for the control plane or a TPM 1.2 node, wipes the disk and leaves the node in HookOS. `attest` netboots HookOS, which attests. `wipe` erases the disk. The status `decommissioning` starts a `retire` run, which wipes the disk and powers the node off, leaving it `offline`.

## Who owns what

| Component | What it owns | Where it lives |
| --- | --- | --- |
| Nodes file | Each node's name, serial, model, class, switch port, address, BMC type and approved EK binding | `clusters/folly/inventory/nodes.yaml` |
| `terraform/netbox/folly` | The device, its address and cable, its declared custom fields, the custom field definitions, fleetd's webhook | Atlantis on offsite |
| NetBox | Status, `desired_action`, verdicts, MACs | capsule |
| fleetd | Attestation, the LDevID and LAK, install codes, renewal, `Hardware`, `Machine`, `Workflow`, the rendered config, retirement | spore |
| [Boot plane](nixos/talos-boot.md) | dnsmasq, nginx, the signed iPXE and HookOS, at `SPORE_BOOTSTRAP_IP` | spore |
| Tinkerbell | Smee, the Tink server and Rufio, which run each `Workflow` | spore |
| [SPIRE](identity.md) | The server, the agents, and `tpm-reattest` | server on spore, agents on the folly nodes |
| [UniFi network](network/routing-and-firewall.md#node-ports) | Node ports, each the Kubernetes network untagged, and that network's DHCP pool for netbooting machines | `terraform/network/unifi/folly/bootstrap.tf`, `k8s.tf` |

## Trust

- Firmware checks images against its Secure Boot database, which also contains Microsoft certificates. After the event-log separator, the node's class picks a policy profile in `apps/fleetd/attest/policy/`: `talos` accepts only the lab's signing authorities, and `ubuntu` also accepts Microsoft's UEFI CA and Canonical's Master CA. Intake requires HookOS. No profile pins an exact image digest.
- The LDevID key stays in the TPM. fleetd signs every LDevID with spore's YubiKey CA, and the bundle keeps the LDevIDs capsule's and the software CA issued trusted until they renew.
- A provision's wipe waits for the boot's pass and the install code, so a refused machine keeps its disk.
- The running node renews its LDevID with a quote that its LAK signs. A `decommissioning` or `offline` device gets no renewal.
- An authenticated quote that misses the policy quarantines a worker: fleetd refuses renewal and cordons it. SPIRE registration removal and existing credential expiry are separate. A control-plane failure records a failed verdict and alerts without a cordon; fleet-owned registration eligibility can change. [Identity](identity.md) has the rules.

## Where to go next

- [Technical design](../reference/folly-design.md): component relationships, sequence diagrams, tradeoffs, evidence and threats.
- [Prepare a machine](../runbooks/prepare-a-machine.md), [Provision a node](../runbooks/provision-a-node.md), [Reprovision a node](../runbooks/reprovision-a-node.md), [Retire a node](../runbooks/retire-a-node.md)
- [Identity](identity.md), [fleetd](../apps/fleetd.md), [Tinkerbell](nixos/tinkerbell.md), [NetBox](netbox.md)
