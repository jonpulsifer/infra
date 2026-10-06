# talos-cluster

Module for the Talos Linux machine configuration of one cluster: an Image Factory schematic, one `talos_machine` per node, and the `talos_cluster` that bootstraps etcd on the control plane and runs Kubernetes upgrades. A root in `clusters/<site>/talos/` calls it with `site`, the version pins and the node map. See [OpenTofu and Atlantis](https://wiki.lolwtf.ca/platform/opentofu/) on the wiki.

The module has no Kubernetes provider and no data source that contacts a node, so a plan succeeds while the cluster is down. The secrets bundle is a 1Password Secure Note whose note is the cluster's `secrets.yaml` in the `talosctl gen secrets` shape. It is read with an ephemeral resource and passed through write-only attributes, so no secret reaches the plan or the state. In that mode the provider skips its live refresh: a plan does not notice a node changed by hand.

Network facts come from `clusters/<site>/config/cluster-topology.json` through `terraform/modules/cluster-topology`, and the DNS zone from `terraform/network/tailscale/fleet.tf.json`. An apply that changes `talos_version`, `extensions` or `extra_kernel_args` upgrades and reboots every node, the control plane first. An apply that changes `kubernetes_version` runs `upgrade-k8s` through `talos_cluster`.

## Develop

```bash
tofu -chdir=terraform/modules/talos-cluster init -backend=false
tofu -chdir=terraform/modules/talos-cluster validate
```

`mise run tf:docs` regenerates the tables below. Atlantis plans each `clusters/<site>/talos` root when this module changes.

<!-- BEGIN_TF_DOCS -->
## Requirements

| Name | Version |
| ---- | ------- |
| <a name="requirement_terraform"></a> [terraform](#requirement\_terraform) | >= 1.11 |
| <a name="requirement_onepassword"></a> [onepassword](#requirement\_onepassword) | ~> 3.0 |
| <a name="requirement_talos"></a> [talos](#requirement\_talos) | ~> 0.12 |

## Providers

| Name | Version |
| ---- | ------- |
| <a name="provider_talos"></a> [talos](#provider\_talos) | ~> 0.12 |

## Modules

| Name | Source | Version |
| ---- | ------ | ------- |
| <a name="module_topology"></a> [topology](#module\_topology) | ../cluster-topology | n/a |

## Resources

| Name | Type |
| ---- | ---- |
| [talos_cluster.this](https://registry.terraform.io/providers/siderolabs/talos/latest/docs/resources/cluster) | resource |
| [talos_image_factory_schematic.this](https://registry.terraform.io/providers/siderolabs/talos/latest/docs/resources/image_factory_schematic) | resource |
| [talos_machine.controlplane](https://registry.terraform.io/providers/siderolabs/talos/latest/docs/resources/machine) | resource |
| [talos_machine.worker](https://registry.terraform.io/providers/siderolabs/talos/latest/docs/resources/machine) | resource |

## Inputs

| Name | Description | Type | Default | Required |
| ---- | ----------- | ---- | ------- | :------: |
| <a name="input_cluster_patches"></a> [cluster\_patches](#input\_cluster\_patches) | Multi-document YAML patches appended to every node after the module's own (CNI inline manifest, sysctls, volumes). | `list(string)` | `[]` | no |
| <a name="input_controlplane_patches"></a> [controlplane\_patches](#input\_controlplane\_patches) | Patches appended to the control plane only (KubeServiceAccountConfig, KubeAuthenticationConfig, KubeAPIServerConfig extraArgs). | `list(string)` | `[]` | no |
| <a name="input_extensions"></a> [extensions](#input\_extensions) | Official Image Factory system extensions baked into the schematic. | `list(string)` | n/a | yes |
| <a name="input_extra_kernel_args"></a> [extra\_kernel\_args](#input\_extra\_kernel\_args) | Kernel arguments baked into the schematic (UKI installs cannot change them any other way). | `list(string)` | `[]` | no |
| <a name="input_kubernetes_version"></a> [kubernetes\_version](#input\_kubernetes\_version) | Kubernetes version, e.g. v1.36.3. Changing it runs upgrade-k8s through talos\_cluster. | `string` | n/a | yes |
| <a name="input_nodes"></a> [nodes](#input\_nodes) | Every machine in the cluster, keyed by hostname. | <pre>map(object({<br/>    address     = string<br/>    role        = string # controlplane | worker<br/>    install     = string # CEL disk selector, e.g. disk.dev_path == "/dev/sda"<br/>    reboot_mode = optional(string, "DEFAULT")<br/>    patches     = optional(list(string), [])<br/>  }))</pre> | n/a | yes |
| <a name="input_op_vault"></a> [op\_vault](#input\_op\_vault) | 1Password vault UUID that holds the secrets bundle. The Atlantis service account must read it. | `string` | n/a | yes |
| <a name="input_secrets_item_uuid"></a> [secrets\_item\_uuid](#input\_secrets\_item\_uuid) | UUID of the 1Password Secure Note whose note is this cluster's secrets.yaml (talosctl gen secrets shape, with the imported service-account signing key). | `string` | n/a | yes |
| <a name="input_site"></a> [site](#input\_site) | Cluster site (folly or offsite). Selects the topology ConfigMap. | `string` | n/a | yes |
| <a name="input_talos_contract"></a> [talos\_contract](#input\_talos\_contract) | Machine-config version contract passed to the generator. Pinned at the version the cluster was created with; never bumped on an OS upgrade. | `string` | `"v1.14"` | no |
| <a name="input_talos_version"></a> [talos\_version](#input\_talos\_version) | Installer tag, e.g. v1.14.2. Changing it upgrades every node (a reboot each). | `string` | n/a | yes |
| <a name="input_workload_isolation"></a> [workload\_isolation](#input\_workload\_isolation) | SecurityProfileConfig.workloadIsolation (sandboxd). Talos 1.14 defaults new clusters to true. | `bool` | `true` | no |

## Outputs

| Name | Description |
| ---- | ----------- |
| <a name="output_installer_image"></a> [installer\_image](#output\_installer\_image) | Installer image every node runs or is upgraded to. |
| <a name="output_nodes"></a> [nodes](#output\_nodes) | Node name to address, as applied. |
| <a name="output_schematic_id"></a> [schematic\_id](#output\_schematic\_id) | Image Factory schematic the nodes are installed from. The install media must use the same ID. |
<!-- END_TF_DOCS -->
