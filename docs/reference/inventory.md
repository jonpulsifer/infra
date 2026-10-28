---
title: Hardware inventory
description: The file that records each folly Kubernetes node as hardware, the code that reads it, and the check that compares it with the machines.
---

`clusters/folly/inventory/machines.yaml` is the single source of truth for folly's Kubernetes nodes as hardware. Each entry is keyed by the node's hostname and holds its MAC, switch port, install disk, TPM version, Intel AMT, expected Secure Boot state, and the model, SKU, serial and BIOS version that the node reports. A node's address stays in `NODE_ADDRESSES` in `clusters/folly/config/cluster-topology.json`, as [Topology](topology.md) describes.

## Readers

| Reader | What it takes | Where |
| --- | --- | --- |
| UniFi | `mac` for the node's DHCP reservation and its MAC auth RADIUS user, `switch_port` for `mab_ports` | `terraform/network/unifi/folly/k8s.tf`, `bootstrap.tf` |
| Talos | `disk` for the install selector, `tpm` for `tpm_nodes` | `clusters/folly/talos/talos.tf` |
| Talos enrollment | `mac` in `node-macs.json` | `scripts/render-machine-inputs.sh` |
| Tinkerbell | `mac` and `disk` in `nodes.env` | `scripts/render-tinkerbell-nodes.sh` |

A change to the file alone gets no Atlantis autoplan. Comment `atlantis plan -d terraform/network/unifi/folly` and `atlantis plan -d clusters/folly/talos` on the pull request, and run both render tasks.

## Drift

`mise run inventory:check` reads each node's SystemInformation, SecurityState and Ethernet link over the Talos API and compares `model`, `sku`, `serial`, `bios`, `mac` and `secure_boot` with the inventory. It prints each difference and exits 1 on any. A firmware update or a board swap is drift until the inventory records it.

`mise run inventory:observe <address>` prints the same fields for one node, ready to paste. Add `--insecure` for a node in maintenance mode, which has no Talos config yet.

## Rules

- Add a node to the inventory before its address goes into `NODE_ADDRESSES`. The UniFi plan fails on a node with no entry.
- Record `tpm` as the spec version the firmware reports, `"2.0"` or `"1.2"`. Only a TPM 2.0 node seals its disks and attests.
- Record `secure_boot` as the state the node is expected to boot in. The check flags a node that boots in any other.
- Retired nodes' MACs stay under `k8s` in `terraform/network/unifi/folly/clients.yaml`.

## Related

- [Topology](topology.md)
- [Enroll a Talos node](../runbooks/enroll-a-talos-node.md)
- [Routing and firewall](../platform/network/routing-and-firewall.md)
