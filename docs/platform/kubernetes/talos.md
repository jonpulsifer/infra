---
title: Talos Linux
description: How the Talos roots install and configure each Kubernetes node, which nodes boot a signed image, and which nodes seal their disks to the TPM.
---

Every Kubernetes node runs Talos Linux. `clusters/<site>/talos/` is an OpenTofu root that calls `terraform/modules/talos-cluster`, and Atlantis applies it over the Talos API. A node's entry in `talos.tf` names its installer, `tpm_nodes` names the nodes whose fresh installs seal their disks to the TPM, and `encrypted_nodes` names the nodes that run encrypted disks now.

## Parts

| Part | Job | Where it runs |
| --- | --- | --- |
| Image Factory installer | Installs a node from the cluster's schematic | Every offsite node |
| Signed installer | `ghcr.io/jonpulsifer/talos-installer-folly`, a UKI signed with the lab's Secure Boot keys | [optiplex](../../hosts/optiplex.md), [riptide](../../hosts/riptide.md) and [shale](../../hosts/shale.md) |
| TPM disk encryption | A fresh install makes `STATE` and `EPHEMERAL` LUKS2 volumes whose key the TPM seals to PCR 7 and to a PCR 11 policy signed by the PCR signing key. Adds the `lolwtf.ca/tpm=true` label. | The install render of optiplex and riptide. No running node yet. |
| Render parity check | Renders folly's nodes with the provider and with `talosctl gen config`, and fails on any byte difference | `.github/workflows/talos-render-parity.yml` |
| Static addresses | `static_addresses` in the module: a `LinkAliasConfig` names the node's one physical NIC `net0`, and its `LinkConfig` carries the node's address in `K8S_NODE_CIDR`, the default route through `ROUTER_IP`, and the anchors' DNS addresses as resolvers. Talos runs no DHCP on the NIC. fleet-controller renders the same from `node_network` in the class inputs. | Every folly node. offsite takes its addresses by DHCP. |

The `ETCD` volume and the `data` user volume stay plain. Talos encrypts a volume only when it formats it, at install.

optiplex, riptide and shale boot Image Factory systemd-boot UKI installs, with Secure Boot off and plain volumes. The signed installer and the encryption take effect when each is reinstalled.

## Rules

- Keep the PCR signing key and the Secure Boot keys in the 1Password item `talos-secureboot`. A UKI signed with other keys does not boot under the enrolled `db`, and a policy signed with another key does not unseal the disks.
- Publish the signed installer for a Talos version before `talos_version` changes in `clusters/folly/talos/talos.tf`. The upgrade pulls the tag that equals `talos_version`.
- Tag the signed installer with the Talos version alone, with no digest. Any other form makes Create reinstall the node.
- Change a node's `installer` together with its `generation`. A new generation replaces its `talos_machine`, whose Create applies the config and upgrades only for a new version tag. An `image` change alone upgrades the node at once.
- Add a node to `encrypted_nodes` only after a reinstall has formatted its volumes encrypted. A running node whose config calls a plain volume encrypted fails its next boot: `EPHEMERAL` reports `block dev type mismatch: xfs != luks` and the kubelet never starts.
- `tpm_nodes` changes only the label and the install render that `install_inputs` and fleet-controller use. It is safe on a running node.
- Run `talosctl apply-config --dry-run` with the render before a `VolumeConfig` change reaches a running node.
- A network document change applies to a running node without a reboot: `talos_machine` applies its config in Talos's `AUTO` mode, which Talos 1.14 runs as `NO_REBOOT`, and reboots a node only for a new installer image.
- Before a static address reaches a node, run `talosctl --nodes <addr> get links` and make sure it lists one physical link: type `ether` with an empty kind, since a bond, VLAN or bridge has one. After it reaches the node, `talosctl --nodes <addr> get linkaliasspecs` names `net0` on its NIC and `talosctl --nodes <addr> get addresses` shows the address from the `configuration` layer. A box with two physical NICs gets no alias and keeps DHCP; give it a narrower selector before its DHCP reservation goes.

## Where it lives

- `terraform/modules/talos-cluster/`: the module. `patches.tf` holds the encryption patch, the `install_inputs` output gives each node's `talosctl gen config` inputs, and `render_inputs` gives fleet-controller its per-class pieces.
- `clusters/<site>/talos/talos.tf`: the version pins, the extensions, the node map, `tpm_nodes` and `encrypted_nodes`
- `.github/scripts/talos-render-parity.sh`: the parity check

## Related

- [Kubernetes](../kubernetes.md)
- [Install Talos on a node](../../runbooks/install-talos-on-a-node.md)
- [OpenTofu and Atlantis](../opentofu.md)
