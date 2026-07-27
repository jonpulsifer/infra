# Each vessel owns its network boundary. Private Service Access gives Cloud SQL
# and Memorystore one Terraform-owned connection without introducing Shared VPC.
resource "google_compute_network" "vessel" {
  name                    = "spindrift-vessel"
  auto_create_subnetworks = false

  depends_on = [google_project_service.service["compute.googleapis.com"]]
}

resource "google_compute_subnetwork" "vessel" {
  name                     = "spindrift-vessel"
  ip_cidr_range            = local.vessel_topology.subnet_cidr
  region                   = local.region
  network                  = google_compute_network.vessel.id
  private_ip_google_access = true
}

resource "google_compute_global_address" "private_services" {
  name          = "spindrift-private-services"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = google_compute_network.vessel.id
}

resource "google_service_networking_connection" "private_services" {
  network                 = google_compute_network.vessel.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_services.name]

  depends_on = [
    google_project_service.service["servicenetworking.googleapis.com"],
  ]
}
