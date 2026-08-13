# A vessel's private network boundary, for vessels that hold Cloud SQL or
# Memorystore. Private Service Connect via service connectivity automation:
# one service connection policy per service class authorizes the producer to
# create its endpoint in the vessel subnet, so nothing here is per-instance.
# Optional per vessel — a vessel serving only Cloud Run and Firebase Hosting
# needs none of this.

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

# Two policies rather than one because a policy is scoped to a single
# (project, network, region, service class) combination, and the two engines
# use different classes. Both draw endpoints from the vessel subnet — a
# regular subnet is the right kind of object here, no special-purpose range.

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

# Memorystore for Valkey — `gcp-memorystore`, not `gcp-memorystore-redis`,
# which is Redis Cluster's class. Valkey does not support custom service
# instance scopes, so the policy carries the defaults and nothing else.
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
