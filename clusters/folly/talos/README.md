# folly talos

The OpenTofu root for the Talos Linux machine configuration of the folly cluster: optiplex as the control plane, riptide and shale as workers. It calls `terraform/modules/talos-cluster`. [Rebuild a cluster on Talos](https://wiki.lolwtf.ca/runbooks/rebuild-a-cluster-on-talos/) is the procedure that first applies it.

`talos.tf` holds the version pins, the schematic's extension list, the node map, `tpm_nodes` and `encrypted_nodes`. Every node names the signed installer `ghcr.io/jonpulsifer/talos-installer-folly` and an install generation. [Talos Linux](https://wiki.lolwtf.ca/platform/kubernetes/talos/) has the installer rules. Each node's address is its entry in `NODE_ADDRESSES` in `clusters/folly/config/cluster-topology.json`. `patches.tf` holds folly's machine-config documents: sysctls, the kubelet seccomp default, the `data` user volume and the capped `EPHEMERAL`, log shipping to Vector, and, on the control plane, the service-account issuer, cross-cluster federation, the `ETCD` partition, Talos API access for the etcd snapshot and the control-plane metrics listeners. State is in `gs://homelab-ng/clusters/folly/talos`.

OpenTofu reads neither `secureboot/` nor `netboot.json`. They hold the public Secure Boot material and the HookOS inputs that `.github/workflows/talos-images.yml` signs into folly's boot images.

The secrets bundle is the 1Password Secure Note `talos-folly-secrets`, which [Issue a talosconfig](https://wiki.lolwtf.ca/runbooks/issue-a-talosconfig/) names. `secrets_item_uuid` holds its UUID, and a plan fails until the variable holds a real one.

## Develop

```bash
tofu -chdir=clusters/folly/talos init -backend=false
tofu -chdir=clusters/folly/talos validate
```

A plan contacts no node. `tofu validate` cannot see a document that Talos rejects, such as a control-plane-only kind on a worker, so render a changed patch with `talosctl gen config` and check it with `talosctl validate --mode metal`. Pass the control plane's patches with `--config-patch-control-plane` and a worker's with `--config-patch-worker`: `--config-patch` patches both types, and a control-plane-only `$patch: delete` then fails on the worker.

## Deploy

The owner applies this root by hand once, when folly is rebuilt. Atlantis applies it from the next pull request. An apply that changes `talos_version` reboots every node, the control plane first. An `extensions` change reaches the nodes from a rebuilt signed installer at their next Talos version.

`.github/scripts/talos-render-parity.sh` renders each node whose inputs are known without state, with the provider and with `talosctl gen config` from a throwaway bundle, and fails on any byte difference. CI runs it on every change to this root or the module.

<!-- BEGIN_TF_DOCS -->
## Requirements

| Name | Version |
| ---- | ------- |
| <a name="requirement_terraform"></a> [terraform](#requirement\_terraform) | >= 1.11 |
| <a name="requirement_onepassword"></a> [onepassword](#requirement\_onepassword) | ~> 3.0 |
| <a name="requirement_talos"></a> [talos](#requirement\_talos) | ~> 0.12 |

## Providers

No providers.

## Modules

| Name | Source | Version |
| ---- | ------ | ------- |
| <a name="module_talos"></a> [talos](#module\_talos) | ../../../terraform/modules/talos-cluster | n/a |
| <a name="module_topology"></a> [topology](#module\_topology) | ../../../terraform/modules/cluster-topology | n/a |

## Resources

No resources.

## Inputs

| Name | Description | Type | Default | Required |
| ---- | ----------- | ---- | ------- | :------: |
| <a name="input_secrets_item_uuid"></a> [secrets\_item\_uuid](#input\_secrets\_item\_uuid) | UUID of the 1Password Secure Note talos-folly-secrets, whose note is folly's Talos secrets bundle. Issue a talosconfig names the item. | `string` | `"a3jq5rtwm4b22eeht7jg6idtli"` | no |

## Outputs

| Name | Description |
| ---- | ----------- |
| <a name="output_installer_image"></a> [installer\_image](#output\_installer\_image) | Installer image each folly node runs. |
| <a name="output_class_inputs"></a> [class\_inputs](#output\_class\_inputs) | Per class, the inputs of talosctl gen config other than the node's own documents and the secrets. fleet-controller renders a node's config from its class's entry and NetBox's facts about the node. |
| <a name="output_nodes"></a> [nodes](#output\_nodes) | Node name to address, as applied. |
| <a name="output_schematic_id"></a> [schematic\_id](#output\_schematic\_id) | Image Factory schematic of folly's nodes without a signed installer. The kexec and PXE assets must use the same ID. |
<!-- END_TF_DOCS -->
