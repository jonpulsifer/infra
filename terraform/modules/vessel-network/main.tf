# A vessel's private network boundary, for vessels that hold Cloud SQL or
# Memorystore. Private Service Access gives both one Terraform-owned
# connection without introducing Shared VPC. Optional per vessel — a vessel
# serving only Cloud Run and Firebase Hosting needs none of this.
#
# The `google.quota` alias exists because Service Networking otherwise charges
# its API request to the project that owns the impersonated service account,
# even though the consumer network and enabled API both belong to the vessel.
# The caller passes a provider with `user_project_override` and
# `billing_project` set to the vessel.

resource "google_compute_network" "vessel" {
  project                 = var.project
  name                    = var.name
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "vessel" {
  project                  = var.project
  name                     = var.name
  ip_cidr_range            = var.subnet_cidr
  region                   = var.region
  network                  = google_compute_network.vessel.id
  private_ip_google_access = true
}

resource "google_compute_global_address" "private_services" {
  project       = var.project
  name          = "spindrift-private-services"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = google_compute_network.vessel.id
}

resource "google_service_networking_connection" "private_services" {
  provider = google.quota

  network                 = google_compute_network.vessel.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_services.name]
}
