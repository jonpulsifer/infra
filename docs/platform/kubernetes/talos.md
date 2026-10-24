---
title: Talos Linux
description: How the Talos roots install and configure each Kubernetes node, which nodes boot a signed image, and which nodes seal their disks to the TPM.
---

Every Kubernetes node runs Talos Linux. `clusters/<site>/talos/` is an OpenTofu root that calls `terraform/modules/talos-cluster`, and Atlantis applies it over the Talos API. A node's entry in `talos.tf` names its installer, and `tpm_nodes` names the nodes whose disks the TPM unlocks.

## Parts

| Part | Job | Where it runs |
| --- | --- | --- |
| Image Factory installer | Installs a node from the cluster's schematic | [shale](../../hosts/shale.md) and every offsite node |
| Signed installer | `ghcr.io/jonpulsifer/talos-installer-folly`, a UKI signed with the lab's Secure Boot keys | [optiplex](../../hosts/optiplex.md) and [riptide](../../hosts/riptide.md) |
| TPM disk encryption | Makes `STATE` and `EPHEMERAL` LUKS2 volumes whose key the TPM seals to PCR 7 and to a PCR 11 policy signed by the PCR signing key. Adds the `lolwtf.ca/tpm=true` label. | optiplex and riptide |
| Render parity check | Renders folly's nodes with the provider and with `talosctl gen config`, and fails on any byte difference | `.github/workflows/talos-render-parity.yml` |

The `ETCD` volume and the `data` user volume stay plain. Talos encrypts a volume only when it formats it, at install.

optiplex and riptide boot Image Factory systemd-boot UKI installs, with Secure Boot off and plain volumes. The signed installer and the encryption take effect when each is reinstalled. optiplex has no TPM until Intel PTT is on in its BIOS.

## Rules

- Keep the PCR signing key and the Secure Boot keys in the 1Password item `talos-secureboot`. A UKI signed with other keys does not boot under the enrolled `db`, and a policy signed with another key does not unseal the disks.
- Publish the signed installer for a Talos version before `talos_version` changes in `clusters/folly/talos/talos.tf`. The upgrade pulls the tag that equals `talos_version`.
- Tag the signed installer with the Talos version alone, with no digest. Any other form makes Create reinstall the node.
- Change a node's `installer` together with its `generation`. A new generation replaces its `talos_machine`, whose Create applies the config and upgrades only for a new version tag. An `image` change alone upgrades the node at once.
- Add a node to `tpm_nodes` only right before it is reinstalled. Talos writes the `STATE` encryption to META when the config applies, and the next boot fails on the plain `STATE`.
- Run `talosctl apply-config --dry-run` with the render before a `VolumeConfig` change reaches a running node.

## Where it lives

- `terraform/modules/talos-cluster/`: the module. `patches.tf` holds the encryption patch, and the `machine_inputs` output gives each node's `talosctl gen config` inputs.
- `clusters/<site>/talos/talos.tf`: the version pins, the extensions, the node map and `tpm_nodes`
- `.github/scripts/talos-render-parity.sh`: the parity check

## Related

- [Kubernetes](../kubernetes.md)
- [Install Talos on a node](../../runbooks/install-talos-on-a-node.md)
- [OpenTofu and Atlantis](../opentofu.md)
