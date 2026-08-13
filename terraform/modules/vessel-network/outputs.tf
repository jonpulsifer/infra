output "network_name" {
  description = "The consumer network a PSC endpoint is created in — the vessel's location.network.name in the installation manifest."
  value       = google_compute_network.vessel.name
}

output "region" {
  description = "Where the service connection policies and subnet are — the vessel's location.network.region in the installation manifest."
  value       = var.region
}
