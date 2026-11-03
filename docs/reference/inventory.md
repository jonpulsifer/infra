---
title: Hardware inventory
description: The nodes file that declares each folly Kubernetes node, the code that reads it, the OpenTofu root that applies it into NetBox, and the check that compares NetBox with the machines.
---

Git declares folly's Kubernetes nodes in `clusters/folly/inventory/nodes.yaml`, the nodes file, and `terraform/netbox/folly` applies it into [NetBox](../platform/netbox.md). Each node is a device with the role `kubernetes-node`. NetBox adds what the services and the owner write: the MAC, the EK hashes fleetd observes, attestation results, SMBIOS facts, the status and `desired_action`.

## Nodes file

The file has two sections:

| Section | Contents |
| --- | --- |
| `models` | Shared hardware facts, keyed by NetBox device type slug |
| `nodes` | One entry per node, keyed by node name |

Model facts include the SMBIOS model, manufacturer, NIC, install disk, TPM version, Intel AMT and expected Secure Boot state.
Each node declares its model, serial, class, switch port, address and BMC type.

A class is a key of `clusters/folly/fleet/classes.json`, the one table that says what a machine of the class runs and for whom: its `os`, its `workload` (`general` today), the attestation profile fleetd holds its boot to, and the payload its install writes. fleetd reads the table on spore, `terraform/netbox/folly` takes the class field's choices from it, and `clusters/folly/talos/` keeps the Talos role and patches of each class whose `os` is `talos`, and the labels and taints its `workload` puts on the node.
A node can override its model's disk, TPM, AMT or Secure Boot setting.

The file's opening comment defines each key. Every value is a scalar on its own line.

### Approved TPM keys

A node can declare two optional endorsement key (EK) hashes:

- `approved_ek_rsa2048`: the TPM's RSA key hash.
- `approved_ek_eccp256`: the TPM's ECC key hash.

Each value is the lowercase hexadecimal SHA-256 hash of the key's DER SubjectPublicKeyInfo.
Keep these as flat keys: every reader expects scalar values.

[fleetd](../apps/fleetd.md) admits a `planned` node only when its TPM proves every approved EK.
A node without a binding waits. Admission permits identity issuance and install-code delivery.

The binding needs independent evidence: a receiving scan or an authenticated supplier record that ties the chassis serial to its EKs.
A claim from fleetd is insufficient evidence. `mise run attest:approve <serial>` prints candidate lines for comparison; it approves nothing.
See [Approve a machine's EKs](../runbooks/provision-a-node.md#approve-a-machines-eks).

### Install disk

Each node declares `disk_serial`, the serial its install disk reports. Quote the value so that digits remain a string.
Models cannot declare this key because each disk has its own serial.

The kernel name in `disk`, such as `/dev/sda`, depends on probe order.
A different disk can acquire that name after a hardware change.
The provision Template wipes and installs only when all these checks pass:

- The disk at `disk` reports `disk_serial`.
- No other disk reports that serial.
- The disk is neither removable nor connected through USB.

fleetd starts no provision, wipe or retirement without a disk serial.
After a disk replacement, update `disk_serial` before the next destructive run.

Read the serial from the disk label or a receiving scan.
On a running node, use `talosctl --nodes <addr> get disks`:

- For NVMe, read `serial`.
- For SATA, read the last word of `wwid`, which has the form `t10.ATA <model> <serial>`.

swell has no declared disk serial because it is powered off and its disk serial is unknown.
It cannot receive a destructive run until a pull request declares the serial.

### Add and validate an entry

Add the node in a pull request. Request the plans listed under [Readers](#readers), then comment `atlantis apply`.
A change to the nodes file alone does not trigger an autoplan.

The plan rejects:

- An unknown model or class.
- An address outside `K8S_NODE_CIDR` in `clusters/folly/config/cluster-topology.json`.
- A shared address, switch port, chassis serial, disk serial or approved EK.
- An approved EK hash other than 64 lowercase hexadecimal characters.
- An unknown key that starts with `approved_`.
- A disk serial set by a model, or an unquoted disk serial.
- A disk serial with characters other than letters, digits, dots, underscores and hyphens.
- An `API_SERVER_IP` that matches no node address.

A node without `disk_serial` can pass the plan, but cannot receive a destructive run.
`tofu test` in `terraform/netbox/folly` checks the fixtures in its `testdata/` directory.
See [Topology](topology.md) for the network keys.

## Terraform

The root creates each device with status `planned`. It declares:

- The serial, device type, site, role and platform.
- The address on the interface from the device type's template, and that address as the primary IPv4.
- A cable to the switch port.
- The fields `class`, `bmc_type`, `install_disk`, `install_disk_serial`, `tpm_version`, `amt` and `secure_boot_expected`.- `expected_port`, which identifies the switch port.

fleetd does not write these fields. It refuses installation when a required field is empty.
A missing `disk_serial` produces a null `install_disk_serial`.

Terraform writes approved keys to `approved_ek_hash` and `approved_ek_hash_ecc`; absent bindings become null.
fleetd reads these fields but does not write them. It records the MAC when the machine attests.

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
| Talos | `address` for the node's static address, `class`, `disk` for the install selector, `tpm` for `tpm_nodes` unless `tpm_off` names the node, for each node NetBox holds `active` or `failed` | `clusters/folly/talos/nodes.tf`, `talos.tf` |
| [fleetd](../apps/fleetd.md) | Nothing from the file; it reads each declared fact, the approved EK binding among them, from the node's NetBox device | `apps/fleetd/fleet/netbox.go` |

The Talos root reads each node's NetBox status at plan time.
Its plan fails if a declared node has no NetBox device.
Apply `terraform/netbox/folly` before planning Talos for a new node.

`mise run render-class-inputs` also requires a NetBox device and reads its status.
The API server's SANs include control planes with status `active` or `failed`.

MACs remain in NetBox. On each reconcile pass, fleetd uses them to link each node's `netboot-not-allowed` TFTP path on spore.

A change to the file alone gets no Atlantis autoplan. Comment `atlantis plan -d terraform/netbox/folly`, `atlantis plan -d terraform/network/unifi/folly` and `atlantis plan -d clusters/folly/talos` on the pull request.

## Drift

`mise run inventory:check` compares NetBox with the machines:

1. Read each planned, active and failed node from NetBox.
2. Query active and failed nodes through the Talos API: SystemInformation, SecurityState and Ethernet link.
3. Compare model, SKU, serial, BIOS, MAC, Secure Boot and address with NetBox.

The check prints each difference and exits with status 1 if it finds drift.
A firmware update or board replacement remains drift until NetBox records it.

With `--record`, the check writes a device journal entry when its findings change.
It also maintains the `drift` tag on each device with a difference.

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
