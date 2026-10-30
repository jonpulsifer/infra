---
title: Hardware inventory
description: The nodes file that declares each folly Kubernetes node, the code that reads it, the OpenTofu root that applies it into NetBox, and the check that compares NetBox with the machines.
---

Git declares folly's Kubernetes nodes in `clusters/folly/inventory/nodes.yaml`, the nodes file, and `terraform/netbox/folly` applies it into [NetBox](../platform/netbox.md). Each node is a device with the role `kubernetes-node`. NetBox adds what the services and the owner write: the MAC, the EK hashes, attestation results, SMBIOS facts, the status and `desired_action`.

## Nodes file

`models` holds what every machine of a model shares, keyed by its NetBox device type slug: the SMBIOS model name, the manufacturer, the NIC its template names, the install disk, the TPM version, Intel AMT and the expected Secure Boot state. `nodes` holds one entry per node, keyed by its name, with its model, serial, Talos class, switch port, address and BMC type. A node may override its model's disk, TPM, AMT or Secure Boot. The comment at the top of the file defines each key, and every value is a scalar on its own line.

To add a node, add its entry in a pull request and comment the plans that [Readers](#readers) names, since a change to the file alone gets no autoplan. Then comment `atlantis apply`. The plan fails on an unknown model or class, an address outside `K8S_NODE_CIDR` in `clusters/folly/config/cluster-topology.json` as [Topology](topology.md) describes, a shared address, switch port or serial, or when `API_SERVER_IP` there is no node's address.

## Terraform

The root creates each device as `planned`, with its serial, device type, site, role and platform, the address on the interface its device type's template makes, that address as the primary IPv4, a cable to the switch port, and the custom fields `talos_class`, `bmc_type`, `install_disk`, `tpm_version`, `amt` and `secure_boot_expected`. No MAC is needed: talos-attest writes it when the machine attests.

| Field or object | Written by |
| --- | --- |
| The device's status after it is created, `desired_action` | The owner and [fleet-controller](../apps/fleet-controller.md) |
| MAC, EK hashes, verdicts, LDevID and LAK serials, `smbios_uuid`, `pcr0_by_bios`, SMBIOS facts, the attested network fields | [talos-attest](../apps/talos-attest.md) |
| `last_workflow` | fleet-controller |
| The rest of the device, the node models' device types, every custom field definition and choice set, and the fleet-controller webhook and event rule | `terraform/netbox/folly` |

Terraform never updates a device in place. A change to an entry's serial, model, address or declared fields goes out as a PATCH of those keys alone. Removing an entry deletes the device, its address and its cable, so retire the node first. The root's `README.md` has the rest.

## Readers

| Reader | What it takes | Where |
| --- | --- | --- |
| NetBox | Every declared fact, applied as the node's device | `terraform/netbox/folly` |
| UniFi | `address` for the node's DNS record, `switch_port` for its node port | `terraform/network/unifi/folly/k8s.tf`, `bootstrap.tf` |
| Talos | `address` for the node's static address, `class`, `disk` for the install selector, `tpm` for `tpm_nodes`, for each node NetBox holds `active` or `failed` | `clusters/folly/talos/nodes.tf`, `talos.tf` |
| spore's SPIRE | each node with `tpm` `2.0`, for its LDevID alias | `nix/lib/inventory.nix`, `nix/hosts/spore.nix` |
| talos-attest | `serial`, `class`, `tpm` and `secure_boot`, as its inventory | `nix/services/talos-attest.nix` |
| fleet-controller | nothing from this file: it reads each device from NetBox | `apps/fleet-controller` |

The Talos root reads each node's status from NetBox at plan time, and `mise run render-class-inputs` reads it too, since the API server's SANs name the control planes NetBox holds `active` or `failed`. The same task writes `clusters/folly/fleet/node-macs.json` from the MACs NetBox holds, which spore's netboot links read.

A change to the file alone gets no Atlantis autoplan. Comment `atlantis plan -d terraform/netbox/folly`, `atlantis plan -d terraform/network/unifi/folly` and `atlantis plan -d clusters/folly/talos` on the pull request, and deploy spore for a new TPM 2.0 node's alias.

## Drift

`mise run inventory:check` reads each planned, active and failed node from NetBox, and then each active and failed node over the Talos API, from its SystemInformation, SecurityState and Ethernet link, and compares `model`, `sku`, `serial`, `bios`, `mac`, `secure_boot` and the address with NetBox. It prints each difference and exits 1 on any. A firmware update or a board swap is drift until NetBox records it. With `--record` it writes a journal entry on the device when its findings change and keeps the `drift` tag on a drifting device.

`mise run inventory:observe <address>` prints the same fields for one node. Add `--insecure` for a node in maintenance mode, which has no Talos config yet.

## Rules

- A node's address is its `address` in the nodes file, which Terraform makes its NetBox primary IPv4 and its Talos config sets statically. It lies outside `K8S_DHCP_CIDR`, or the UniFi plan fails. Every declared node gets a DNS record.
- Declare `tpm` as the spec version the firmware reports, `2.0` or `1.2`. Only a TPM 2.0 node seals its disks and attests.
- Declare `secure_boot` as the state the node is expected to boot in. The check flags a node that boots in any other.
- Retire a node by moving its device to `decommissioning`. Remove its entry from the nodes file once it is `offline`.

## Related

- [NetBox](../platform/netbox.md)
- [Node lifecycle](../platform/node-lifecycle.md)
- [Topology](topology.md)
- [Provision a node](../runbooks/provision-a-node.md)
- [Retire a node](../runbooks/retire-a-node.md)
- [Routing and firewall](../platform/network/routing-and-firewall.md)
