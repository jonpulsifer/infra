---
title: Hardware inventory
description: NetBox's record of each folly Kubernetes node as hardware, the file it exports for the code that reads it, and the check that compares it with the machines.
---

[NetBox](../platform/netbox.md) is the single source of truth for folly's Kubernetes nodes as hardware. Each node is a device with the role `kubernetes-node` that holds its serial, model, NIC and MAC, its cable to a switch port, and the custom fields for its SKU, BIOS version, install disk, TPM version, Intel AMT and expected Secure Boot state, its Talos class and its BMC type. A node's address is the device's primary IPv4, which the export carries as `address`. The UniFi reservation and DNS record, and the Talos root, read it from the export, and `mise run netbox:check` fails when a node's address is outside `K8S_NODE_CIDR` in `clusters/folly/config/cluster-topology.json`, as [Topology](topology.md) describes, or is shared.

## Export

`clusters/folly/inventory/machines.yaml` is NetBox's export: every folly device with the role `kubernetes-node` and the status `planned`, `staged`, `active` or `failed`, keyed by name and ordered by address. A device in `decommissioning` or `offline` is not exported, nor is a stub, a `planned` device with no serial or no MAC that fleet-controller has not bound to a machine. Beside the hardware keys, each node has `class` (the `talos_class` field: `controlplane`, `worker-g5` or `worker-g2`), `status`, `address`, `bmc`, `ek_hash` and `ek_hash_ecc`. `bmc.type` is the `bmc_type` field (`none`, `amt` or `redfish`); `bmc.address` is the device's out-of-band address, or the node's own address for AMT when NetBox holds none. Never edit it by hand. Change the device in NetBox, then:

```sh
mise run netbox:export
```

Commit the file in a pull request. `mise run netbox:check` fails when the committed file differs from NetBox, and when the export's staged, active and failed nodes fail the address checks. Both reach NetBox over the tailnet and read the API token from the 1Password item `netbox-folly`, or from `NETBOX_TOKEN`; `scripts/lib/netbox.sh` lists the variables. Off the tailnet, forward capsule's `127.0.0.1:8080` over ssh and set `NETBOX_URL` to the forwarded port and `NETBOX_HOST` to capsule's tailnet name.

capsule's hourly drift job compares NetBox's export with the file on `main` and raises `NetboxExportDiffers` after two hours of difference. The export stays a manual step because no anchor holds a GitHub credential that can open a pull request.

## Readers

| Reader | What it takes | Where |
| --- | --- | --- |
| UniFi | `mac` for the node's DHCP reservation and its MAC auth RADIUS user, `switch_port` for `mab_ports` | `terraform/network/unifi/folly/k8s.tf`, `bootstrap.tf` |
| Talos | `disk` for the install selector, `tpm` for `tpm_nodes` | `clusters/folly/talos/talos.tf` |
| spore's netboot links | `mac`, written to `clusters/folly/fleet/node-macs.json` | `scripts/render-class-inputs.sh`, `nix/services/tinkerbell.nix` |
| Tinkerbell | nothing from this file: [fleet-controller](../apps/fleet-controller.md) reads the MAC, install disk and BMC of each device from NetBox itself | `apps/fleet-controller` |

A change to the file alone gets no Atlantis autoplan. Comment `atlantis plan -d terraform/network/unifi/folly` and `atlantis plan -d clusters/folly/talos` on the pull request, and run both render tasks.

## Drift

`mise run inventory:check` reads each staged, active and failed node's address from NetBox, and then the node over the Talos API, from its SystemInformation, SecurityState and Ethernet link, and compares `model`, `sku`, `serial`, `bios`, `mac`, `secure_boot` and the address with NetBox. It prints each difference and exits 1 on any. A firmware update or a board swap is drift until NetBox records it.

`netbox-drift.service` on capsule runs the same check every hour with `--record`. It mints a one-hour `os:reader` Talos certificate from folly's secrets bundle, writes a journal entry on the device when its findings change, keeps the `drift` tag on a drifting device, and exports `netbox_drift{device}` for `NetboxNodeDrift`. `nix/services/netbox-drift.nix` declares it.

`mise run inventory:observe <address>` prints the same fields for one node. Add `--insecure` for a node in maintenance mode, which has no Talos config yet.

## Rules

- A node's address is its NetBox primary IPv4. The UniFi plan fails on a node with no MAC. A `planned` node gets a reservation once it has a MAC, a switch port and an address, and no DNS record; a `staged`, `active` or `failed` node gets both.
- Record `tpm_version` as the spec version the firmware reports, `2.0` or `1.2`. Only a TPM 2.0 node seals its disks and attests.
- Record `secure_boot_expected` as the state the node is expected to boot in. The check flags a node that boots in any other.
- Retire a node by moving its device to `decommissioning` or `offline` and merging the export that drops it.

## Related

- [NetBox](../platform/netbox.md)
- [Topology](topology.md)
- [Provision a node](../runbooks/provision-a-node.md)
- [Retire a node](../runbooks/retire-a-node.md)
- [Routing and firewall](../platform/network/routing-and-firewall.md)
