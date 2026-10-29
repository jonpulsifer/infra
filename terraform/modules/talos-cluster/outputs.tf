output "schematic_id" {
  description = "Image Factory schematic the nodes are installed from. The install media must use the same ID."
  value       = talos_image_factory_schematic.this.id
}

output "installer_image" {
  description = "Image Factory installer of every node that sets no installer_image."
  value       = local.installer_image
}

output "node_installer_images" {
  description = "Installer image each node runs or is upgraded to."
  value       = local.node_installer_image
}

output "nodes" {
  description = "Node name to address, as applied."
  value       = { for name, n in var.nodes : name => n.address }
}

# Everything but the secrets bundle that a node's fresh install is rendered
# from, for talosctl gen config: one --config-patch-<control-plane|worker> per
# patch, in order. .github/scripts/talos-render-parity.sh renders each node
# from it with the provider, with talosctl, and through the enrollment
# server's class render, and fails on a byte of difference. tofu console
# evaluates it with a local backend and no state.
output "install_inputs" {
  description = "Per node: machine_type, cluster_name, cluster_endpoint, talos_contract, kubernetes_version and the ordered config_patches of a fresh install."
  value = { for name, n in var.nodes : name => {
    machine_type       = n.role
    cluster_name       = local.topology.CLUSTER_NAME
    cluster_endpoint   = local.cluster_endpoint
    talos_contract     = var.talos_contract
    kubernetes_version = var.kubernetes_version
    config_patches     = local.install_patches[name]
  } }
}

# What a fresh install's config is rendered from, short of the node's own
# documents and the secrets: the enrollment server renders a node of a class
# from these, in this order, with the node document between the cluster
# patches and the class's own. The node document it renders (hostname,
# install target, certSANs, labels) mirrors node_docs in patches.tf, and the
# parity check above holds the two together.
output "render_inputs" {
  description = "cluster_name, cluster_endpoint, talos_contract, kubernetes_version, dns_zone, the cluster and control-plane patch lists in order, the TPM node patches of a fresh install, and the TPM node label."
  value = {
    cluster_name         = local.topology.CLUSTER_NAME
    cluster_endpoint     = local.cluster_endpoint
    talos_contract       = var.talos_contract
    kubernetes_version   = var.kubernetes_version
    dns_zone             = local.dns_zone
    cluster_patches      = concat([local.cluster_patch], var.cluster_patches)
    controlplane_patches = concat([local.controlplane_patch], var.controlplane_patches)
    tpm_patches          = concat(local.tpm_volume_patches, [local.tpm_no_kexec_patch])
    tpm_labels           = { "lolwtf.ca/tpm" = "true" }
  }
}
