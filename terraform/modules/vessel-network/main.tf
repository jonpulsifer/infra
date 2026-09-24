# A vessel's private network for Cloud SQL and Memorystore over Private Service Connect.
# One service connection policy per service class lets its producer create endpoints in the subnet.

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

# A policy covers one project, network, region and service class.
resource "google_network_connectivity_service_connection_policy" "cloudsql" {
  project       = var.project
  name          = "${var.name}-cloudsql"
  location      = var.region
  network       = google_compute_network.vessel.id
  service_class = "google-cloud-sql"

  psc_config {
    subnetworks = [google_compute_subnetwork.vessel.id]
  }
}

# gcp-memorystore is Valkey's class; gcp-memorystore-redis is Redis Cluster's.
# Valkey supports no custom service instance scopes.
resource "google_network_connectivity_service_connection_policy" "memorystore" {
  project       = var.project
  name          = "${var.name}-memorystore"
  location      = var.region
  network       = google_compute_network.vessel.id
  service_class = "gcp-memorystore"

  psc_config {
    subnetworks = [google_compute_subnetwork.vessel.id]
  }
}
