---
title: Node lifecycle
description: How a folly node goes from a NetBox device to an attested Talos node with a SPIRE identity, and back out, with the system that owns each step.
---

A folly node is an entry in `clusters/folly/inventory/nodes.yaml`, which `terraform/netbox/folly` applies into [NetBox](netbox.md) as a `kubernetes-node` device. [fleetd](../apps/fleetd.md) on spore attests it and drives each run. [Identity](identity.md#lifecycle) lists the statuses and who writes each, and [Hardware inventory](../reference/inventory.md) the nodes file.

## At a glance

The owner acts twice, at the start and when a machine first attests. Everything after that is a component reacting to the one before it.

| Step | Who | What happens |
| --- | --- | --- |
| 1 | The owner, then Atlantis | The owner adds the node to the nodes file in a pull request, with the EK hashes from independent evidence as its approved binding. Atlantis applies `terraform/netbox/folly`, which creates a `planned` device with no MAC address. |
| 2 | The owner, then the firmware and spore's boot plane | The owner connects the machine to its node port and powers it on. Firmware PXE loads signed iPXE from spore, then signed HookOS. |
| 3 | HookOS and fleetd | HookOS runs `tink-attest`, which proves the TPM identity and boot state to fleetd. fleetd records the MAC against the device's serial. |
| 4 | fleetd | fleetd checks every approved EK, then issues the LDevID and LAK certificates. Without an approved binding, the machine waits, and the owner's only move is to [approve its EKs](../runbooks/provision-a-node.md#approve-a-machines-eks) in the nodes file. |
| 5 | fleetd and Tinkerbell | The signed confirmation triggers admission. fleetd checks the reported switch port, starts a Tinkerbell `provision` Workflow and renders the Talos configuration. |
| 6 | fleetd, then the Workflow in HookOS | fleetd returns an install code wrapped to the TPM. The Workflow wipes the system disk, installs Talos and stores the code in META. |
| 7 | Talos and fleetd | Talos boots from disk and fetches its configuration from `/talos/config` with the UUID and code. The configuration supplies its static address. |
| 8 | fleetd | After the complete response, fleetd deletes the configuration and sets the device `active` in NetBox. |
| 9 | The kubelet and fleetd | fleetd approves the worker's initial kubelet certificate only when its per-node bootstrap token and requested node name match. Kubernetes readiness remains separate. |
| 10 | fleetd, spore's SPIRE entries sync, the SPIRE agent | fleetd lists the `active`, attested node in `spire-nodes.json`, and spore's `spire-server-fleet-entries` registers the node's SPIRE entry, `spiffe://lolwtf.ca/node/<name>`, from it. The SPIRE agent then attests by LDevID and serves SVIDs, since each workload entry is parented to that node entry. [Identity](identity.md#fleetd-entries) has the entries. |

An unknown serial also waits. A machine must prove every EK that its inventory entry approves before fleetd issues an identity.

## Actions after installation

The owner requests an action through NetBox. Rufio uses the node's AMT address to boot it into HookOS when needed.

| Request | Result |
| --- | --- |
| `desired_action: provision` | Reinstalls an eligible node. HookOS attestation obtains the install code. |
| `desired_action: attest` | Boots HookOS and attests the node. |
| `desired_action: wipe` | Erases the disk. |
| Status `decommissioning` | Starts retirement: wipes and erases the entire disk, powers off the node and sets it `offline`. |

Retirement also cordons the Kubernetes node, evicts its pods and deletes its cluster records before fleetd marks it `offline`.

A provision for an unsupported node, such as a TPM 1.2 node, wipes the disk and leaves it in HookOS. Control-plane installation additionally requires `homelab.fleetd.controlPlanes`; it is disabled by default.

See [Identity](identity.md#terms) for the credential terms and [Tinkerbell](nixos/tinkerbell.md) for the Workflow components.

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

- [Security engineering brief](../reference/purchase-to-identity.md): purchase, receiving, trust boundaries and off-the-shelf alternatives.
- [Technical design](../reference/folly-design.md): component relationships, sequence diagrams, tradeoffs, evidence and threats.
- [Prepare a machine](../runbooks/prepare-a-machine.md), [Provision a node](../runbooks/provision-a-node.md), [Reprovision a node](../runbooks/reprovision-a-node.md), [Retire a node](../runbooks/retire-a-node.md)
- [Identity](identity.md), [fleetd](../apps/fleetd.md), [Tinkerbell](nixos/tinkerbell.md), [NetBox](netbox.md)
