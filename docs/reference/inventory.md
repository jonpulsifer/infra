---
title: Hardware inventory
description: The nodes file that declares each folly Kubernetes node, the code that reads it, the OpenTofu root that applies it into NetBox, and the check that compares NetBox with the machines.
---

Git declares folly's Kubernetes nodes in `clusters/folly/inventory/nodes.yaml`, the nodes file, and `terraform/netbox/folly` applies it into [NetBox](../platform/netbox.md). Each node is a device with the role `kubernetes-node`. NetBox adds what the services and the owner write: the MAC, the EK hashes fleetd observes, attestation results, SMBIOS facts, the status and `desired_action`.

## Nodes file

`models` holds what every machine of a model shares, keyed by its NetBox device type slug: the SMBIOS model name, the manufacturer, the NIC its template names, the install disk, the TPM version, Intel AMT and the expected Secure Boot state. `nodes` holds one entry per node, keyed by its name, with its model, serial, Talos class, switch port, address and BMC type. A node may override its model's disk, TPM, AMT or Secure Boot. The comment at the top of the file defines each key, and every value is a scalar on its own line.

A node may also carry its approved EK binding: `approved_ek_rsa2048` and `approved_ek_eccp256`, each optional, the hash of the TPM's RSA and ECC endorsement key as [fleetd](../apps/fleetd.md) hashes an EK, the lowercase hex SHA-256 of its DER SubjectPublicKeyInfo. fleetd admits a `planned` node, and issues its identity and install code, only when its TPM proves every approved EK, so a node without a binding waits. The binding is two flat keys, not a nested map, because every reader takes the file's scalar shape as it is. The receiving step is its trust source: a receiving scan of the TPM, or the supplier's authenticated record that ties the chassis serial to its EKs. A claim fleetd shows proves nothing on its own, and `mise run attest:approve <serial>` only prints the lines to compare. [Approve a machine's EKs](../runbooks/provision-a-node.md#approve-a-machines-eks) is the procedure.

A node also carries `disk_serial`, the serial its install disk reports, quoted so that a serial of digits stays a string. `disk` is a kernel name such as `/dev/sda`, which follows probe order, so a swapped slot, a missing disk or a USB stick can take it. The provision Template therefore wipes and installs the disk at `disk` only when that disk reports `disk_serial`, no other disk reports it, and it is neither removable nor on USB, and fleetd starts no `provision`, `wipe` or retirement for a node without one. The serial belongs to one disk, so a model never sets it. Read it from the disk's label or a receiving scan, and on a running node from `talosctl --nodes <addr> get disks`: an NVMe disk's `serial`, or the last word of a SATA disk's `wwid`, which reads `t10.ATA <model> <serial>`. A replaced disk needs a new `disk_serial` before its node's next run that wipes. swell's entry has none, because swell is powered off and nobody has read its disk, so swell gets no run that wipes until a pull request adds it.

To add a node, add its entry in a pull request and comment the plans that [Readers](#readers) names, since a change to the file alone gets no autoplan. Then comment `atlantis apply`. The plan fails on an unknown model or class, an address outside `K8S_NODE_CIDR` in `clusters/folly/config/cluster-topology.json` as [Topology](topology.md) describes, a shared address, switch port or serial, an EK two nodes approve, an approved EK hash that is not 64 lowercase hex characters, another key that starts with `approved_`, a `disk_serial` that two nodes share, that is not a quoted string of letters, digits, dots, underscores and hyphens, or that a model sets, or when `API_SERVER_IP` there is no node's address. A node without `disk_serial` plans. `tofu test` in `terraform/netbox/folly` runs these checks against the fixtures in its `testdata/`.

## Terraform

The root creates each device as `planned`, with its serial, device type, site, role and platform, the address on the interface its device type's template makes, that address as the primary IPv4, a cable to the switch port, and the custom fields `talos_class`, `bmc_type`, `install_disk`, `install_disk_serial`, `tpm_version`, `amt`, `secure_boot_expected` and `expected_port`, the switch port. fleetd writes none of them and refuses an install while one is empty. `install_disk_serial` goes to null for a node without `disk_serial`. The approved binding goes to `approved_ek_hash` and `approved_ek_hash_ecc`, and to null for a node without one; fleetd reads them and never writes them. No MAC is needed: fleetd writes it when the machine attests.

| Field or object | Written by |
| --- | --- |
| The device's status after it is created, `desired_action` | The owner and [fleetd](../apps/fleetd.md) |
| MAC, the observed EK hashes `ek_hash` and `ek_hash_ecc`, verdicts, LDevID and LAK serials, `smbios_uuid`, `pcr0_by_bios`, SMBIOS facts, the attested network fields | fleetd |
| `last_workflow` | fleetd |
| The rest of the device, the node models' device types, every custom field definition and choice set, and fleetd's webhook and event rule | `terraform/netbox/folly` |

Terraform never updates a device in place. A change to an entry's serial, model, address or declared fields goes out as a PATCH of those keys alone. Removing an entry deletes the device, its address and its cable, so retire the node first. The root's `README.md` has the rest.

## Readers

| Reader | What it takes | Where |
| --- | --- | --- |
| NetBox | Every declared fact, applied as the node's device | `terraform/netbox/folly` |
| UniFi | `address` for the node's DNS record, `switch_port` for its node port | `terraform/network/unifi/folly/k8s.tf`, `bootstrap.tf` |
| Talos | `address` for the node's static address, `class`, `disk` for the install selector, `tpm` for `tpm_nodes`, for each node NetBox holds `active` or `failed` | `clusters/folly/talos/nodes.tf`, `talos.tf` |
| [fleetd](../apps/fleetd.md) | Nothing from the file; it reads each declared fact, the approved EK binding among them, from the node's NetBox device | `apps/fleetd/fleet/netbox.go` |

The Talos root reads each node's status from NetBox at plan time, and its plan fails when NetBox holds no device for a declared node, so a new node's device comes from an apply of `terraform/netbox/folly` first. `mise run render-class-inputs` refuses the same case, and reads each status too, since the API server's SANs name the control planes NetBox holds `active` or `failed`. The MACs stay in NetBox: fleetd on spore links each one's `netboot-not-allowed` TFTP path from them on each reconcile pass.

A change to the file alone gets no Atlantis autoplan. Comment `atlantis plan -d terraform/netbox/folly`, `atlantis plan -d terraform/network/unifi/folly` and `atlantis plan -d clusters/folly/talos` on the pull request.

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
