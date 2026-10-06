# folly talos

The OpenTofu root for the Talos Linux machine configuration of the folly cluster: optiplex as the control plane, riptide and shale as workers. It calls `terraform/modules/talos-cluster`. [Rebuild a cluster on Talos](https://wiki.lolwtf.ca/runbooks/rebuild-a-cluster-on-talos/) is the procedure that first applies it.

`talos.tf` holds the version pins, the schematic's extension list and the node map. Each node's address is its entry in `NODE_ADDRESSES` in `clusters/folly/config/cluster-topology.json`. `patches.tf` holds folly's machine-config documents: sysctls, the kubelet seccomp default, the `data` user volume and the capped `EPHEMERAL`, log shipping to Vector, and, on the control plane, the service-account issuer, cross-cluster federation, the `ETCD` partition, Talos API access for the etcd snapshot and the control-plane metrics listeners. State is in `gs://homelab-ng/clusters/folly/talos`.

The secrets bundle is the 1Password Secure Note `talos-folly-secrets`, which [Issue a talosconfig](https://wiki.lolwtf.ca/runbooks/issue-a-talosconfig/) names. `secrets_item_uuid` holds its UUID, and a plan fails until the variable holds a real one.

## Develop

```bash
tofu -chdir=clusters/folly/talos init -backend=false
tofu -chdir=clusters/folly/talos validate
```

A plan contacts no node. `tofu validate` cannot see a document that Talos rejects, such as a control-plane-only kind on a worker, so render a changed patch with `talosctl gen config` and check it with `talosctl validate --mode metal`. Pass the control plane's patches with `--config-patch-control-plane` and a worker's with `--config-patch-worker`: `--config-patch` patches both types, and a control-plane-only `$patch: delete` then fails on the worker.

## Deploy

The owner applies this root by hand once, when folly is rebuilt. Atlantis applies it from the next pull request. An apply that changes `talos_version` or `extensions` reboots every node, the control plane first.

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
| <a name="input_secrets_item_uuid"></a> [secrets\_item\_uuid](#input\_secrets\_item\_uuid) | UUID of the 1Password Secure Note talos-folly-secrets, whose note is folly's Talos secrets bundle. Issue a talosconfig names the item. | `string` | `"PLACEHOLDER-create-talos-folly-secrets"` | no |

## Outputs

| Name | Description |
| ---- | ----------- |
| <a name="output_installer_image"></a> [installer\_image](#output\_installer\_image) | Installer image every folly node runs. |
| <a name="output_nodes"></a> [nodes](#output\_nodes) | Node name to address, as applied. |
| <a name="output_schematic_id"></a> [schematic\_id](#output\_schematic\_id) | Image Factory schematic of folly's nodes. The kexec and PXE assets must use the same ID. |
<!-- END_TF_DOCS -->
