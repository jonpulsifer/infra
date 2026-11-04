# talos-cluster

Module for the Talos Linux machine configuration of one cluster: an Image Factory schematic, one `talos_machine` per node, and the `talos_cluster` that bootstraps etcd on the control plane at `API_SERVER_IP` and runs Kubernetes upgrades. Every other control plane joins that one, after `talos_cluster`, as `talos_machine.joining`. A root in `clusters/<site>/talos/` calls it with `site`, the version pins and the node map. See [OpenTofu and Atlantis](https://wiki.lolwtf.ca/platform/opentofu/) on the wiki.

The module has no Kubernetes provider and no data source that contacts a node, so a plan succeeds while the cluster is down. The secrets bundle is a 1Password Secure Note whose note is the cluster's `secrets.yaml` in the `talosctl gen secrets` shape. It is read with an ephemeral resource and passed through write-only attributes, so no secret reaches the plan or the state. In that mode the provider skips its live refresh: a plan does not notice a node changed by hand.

Network facts come from `clusters/<site>/config/cluster-topology.json` through `terraform/modules/cluster-topology`, and the DNS zone from `terraform/network/tailscale/fleet.tf.json`. An apply that changes `talos_version`, `extensions` or `extra_kernel_args` upgrades and reboots every node, the control plane at `API_SERVER_IP` first. An apply that changes `kubernetes_version` runs `upgrade-k8s` through `talos_cluster`. With `static_addresses`, each node's config names its one physical NIC `net0` and sets its address in `K8S_NODE_CIDR`, the default route through `ROUTER_IP` and `nameservers`, with no DHCP; `render_inputs.node_network` gives fleet-controller the same link, prefix length and gateway. A config change applies without a reboot.

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
| <a name="provider_terraform"></a> [terraform](#provider\_terraform) | n/a |

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
| [talos_machine.joining](https://registry.terraform.io/providers/siderolabs/talos/latest/docs/resources/machine) | resource |
| [talos_machine.worker](https://registry.terraform.io/providers/siderolabs/talos/latest/docs/resources/machine) | resource |
| [terraform_data.install](https://registry.terraform.io/providers/hashicorp/terraform/latest/docs/resources/data) | resource |

## Inputs

| Name | Description | Type | Default | Required |
| ---- | ----------- | ---- | ------- | :------: |
| <a name="input_cluster_patches"></a> [cluster\_patches](#input\_cluster\_patches) | Multi-document YAML patches appended to every node after the module's own (CNI inline manifest, sysctls, volumes). | `list(string)` | `[]` | no |
| <a name="input_controlplane_patches"></a> [controlplane\_patches](#input\_controlplane\_patches) | Patches appended to the control plane only (KubeServiceAccountConfig, KubeAuthenticationConfig, KubeAPIServerConfig extraArgs). | `list(string)` | `[]` | no |
| <a name="input_encrypted_nodes"></a> [encrypted\_nodes](#input\_encrypted\_nodes) | TPM nodes that were installed with encrypted STATE and EPHEMERAL. Only these get the encryption documents while running; a plain-installed node that gets them fails its next boot. | `set(string)` | `[]` | no |
| <a name="input_extensions"></a> [extensions](#input\_extensions) | Official Image Factory system extensions baked into the schematic. | `list(string)` | n/a | yes |
| <a name="input_extra_kernel_args"></a> [extra\_kernel\_args](#input\_extra\_kernel\_args) | Kernel arguments baked into the schematic (UKI installs cannot change them any other way). | `list(string)` | `[]` | no |
| <a name="input_kubernetes_version"></a> [kubernetes\_version](#input\_kubernetes\_version) | Kubernetes version, e.g. v1.36.3. Changing it runs upgrade-k8s through talos\_cluster. | `string` | n/a | yes |
| <a name="input_nameservers"></a> [nameservers](#input\_nameservers) | The resolvers of a node with a static address. | `list(string)` | `[]` | no |
| <a name="input_nodes"></a> [nodes](#input\_nodes) | Every machine in the cluster, keyed by hostname. | <pre>map(object({<br/>    address     = string<br/>    role        = string # controlplane | worker<br/>    install     = string # CEL disk selector, e.g. disk.dev_path == "/dev/sda"<br/>    reboot_mode = optional(string, "DEFAULT")<br/>    patches     = optional(list(string), [])<br/>    labels      = optional(map(string), {})<br/>    taints      = optional(map(string), {}) # key => "value:Effect"<br/>    # Replaces the Image Factory installer. Tag it with talos_version and no<br/>    # digest, or Create upgrades the node.<br/>    installer_image = optional(string)<br/>    # A change replaces the node's talos_machine (see nodes.tf).<br/>    install_generation = optional(string)<br/>    # Replaces the bundle's bootstrap token in a worker's config. A worker<br/>    # that joins with a token another system creates for its install alone<br/>    # gets one no Secret holds, so the config this root applies leaves no<br/>    # lasting join credential on its disk.<br/>    bootstrap_token = optional(string)<br/>  }))</pre> | n/a | yes |
| <a name="input_op_vault"></a> [op\_vault](#input\_op\_vault) | 1Password vault UUID that holds the secrets bundle. The Atlantis service account must read it. | `string` | n/a | yes |
| <a name="input_secrets_item_uuid"></a> [secrets\_item\_uuid](#input\_secrets\_item\_uuid) | UUID of the 1Password Secure Note whose note is this cluster's secrets.yaml (talosctl gen secrets shape, with the imported service-account signing key). | `string` | n/a | yes |
| <a name="input_site"></a> [site](#input\_site) | Cluster site (folly or offsite). Selects the topology ConfigMap. | `string` | n/a | yes |
| <a name="input_static_addresses"></a> [static\_addresses](#input\_static\_addresses) | Configure every node's address statically: its address in K8S\_NODE\_CIDR's prefix on its one physical NIC, the default route through ROUTER\_IP, and the resolvers below, with no DHCP. Off, Talos runs its default DHCP on every physical link. | `bool` | `false` | no |
| <a name="input_talos_contract"></a> [talos\_contract](#input\_talos\_contract) | Machine-config version contract passed to the generator. Pinned at the version the cluster was created with; never bumped on an OS upgrade. | `string` | `"v1.14"` | no |
| <a name="input_talos_version"></a> [talos\_version](#input\_talos\_version) | Installer tag, e.g. v1.14.2. Changing it upgrades every node (a reboot each). | `string` | n/a | yes |
| <a name="input_tpm_nodes"></a> [tpm\_nodes](#input\_tpm\_nodes) | Nodes labelled lolwtf.ca/tpm=true. A fresh install of one makes STATE and EPHEMERAL LUKS2 volumes sealed to the TPM, and kexec is off on them. | `set(string)` | `[]` | no |
| <a name="input_workload_isolation"></a> [workload\_isolation](#input\_workload\_isolation) | SecurityProfileConfig.workloadIsolation (sandboxd). Talos 1.14 defaults new clusters to true. | `bool` | `true` | no |

## Outputs

| Name | Description |
| ---- | ----------- |
| <a name="output_install_inputs"></a> [install\_inputs](#output\_install\_inputs) | Per node: machine\_type, cluster\_name, cluster\_endpoint, talos\_contract, kubernetes\_version, the ordered config\_patches of a fresh install, and the bootstrap\_token that replaces the bundle's, or null. |
| <a name="output_installer_image"></a> [installer\_image](#output\_installer\_image) | Image Factory installer of every node that sets no installer\_image. |
| <a name="output_node_installer_images"></a> [node\_installer\_images](#output\_node\_installer\_images) | Installer image each node runs or is upgraded to. |
| <a name="output_nodes"></a> [nodes](#output\_nodes) | Node name to address, as applied. |
| <a name="output_render_inputs"></a> [render\_inputs](#output\_render\_inputs) | cluster\_name, cluster\_endpoint, talos\_contract, kubernetes\_version, dns\_zone, the cluster and control-plane patch lists in order, the TPM node patches of a fresh install, the TPM node label, and the link, prefix length and gateway of a static address (null without static\_addresses). |
| <a name="output_schematic_id"></a> [schematic\_id](#output\_schematic\_id) | Image Factory schematic the nodes are installed from. The install media must use the same ID. |
<!-- END_TF_DOCS -->
