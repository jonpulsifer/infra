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

# Everything but the secrets bundle that a node's config is rendered from, for
# talosctl gen config: one --config-patch-<control-plane|worker> per patch, in
# order. tofu console evaluates it with a local backend and no state, where a
# node whose installer comes from the schematic is unknown.
output "machine_inputs" {
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
