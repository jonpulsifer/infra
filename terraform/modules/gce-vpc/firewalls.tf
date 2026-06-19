resource "google_compute_firewall" "ssh" {
  name          = "terraform-auto-ssh-firewall"
  network       = google_compute_network.network.name
  source_ranges = var.external_ssh ? ["0.0.0.0/0"] : ["35.235.240.0/20"]
  direction     = "INGRESS"
  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
}
