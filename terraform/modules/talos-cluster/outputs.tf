output "schematic_id" {
  description = "Image Factory schematic the nodes are installed from. The install media must use the same ID."
  value       = talos_image_factory_schematic.this.id
}

output "installer_image" {
  description = "Installer image every node runs or is upgraded to."
  value       = local.installer_image
}

output "nodes" {
  description = "Node name to address, as applied."
  value       = { for name, n in var.nodes : name => n.address }
}
