module "network" {
  source = "github.com/jonpulsifer/terraform-modules/gce-vpc"
  providers = {
    google = google.free-tier
    google-beta = google-beta.free-tier
  }
  name = "vpc"
  subnet_name = "computers"
  ip_cidr_range = "10.13.37.0/28"
}

resource "google_service_account" "vm" {
  account_id = "oldboy"
  display_name = "Old Boy VM Service Account"
}

data "cloudflare_ip_ranges" "cloudflare" {}

resource "google_compute_firewall" "allow_postgres" {
  name = "allow-postgres"
  network = module.network.network.self_link
  allow {
    protocol = "tcp"
    ports = ["5432"]
  }
  source_ranges = data.cloudflare_ip_ranges.cloudflare.cidr_blocks
  target_service_accounts = [google_service_account.vm.email]
}

resource "google_compute_instance" "oldboy" {
  provider = google.free-tier
  name = "oldboy"
  description = "Old Boy VM to race with Pat"
  machine_type = "e2-micro"
  boot_disk {
    auto_delete = true
    initialize_params {
      image = "ubuntu-os-cloud/ubuntu-2404-lts-amd64"
      size = 16 # free tier
      type = "pd-standard" # free tier
    }
  }
  network_interface {
    network = module.network.network.self_link
    subnetwork = module.network.subnet.self_link
    access_config {
      network_tier = "STANDARD" # free tier
    }
  }

  service_account {
    email = google_service_account.vm.email
    scopes = ["cloud-platform"]
  }

  shielded_instance_config {
    enable_secure_boot = true
    enable_vtpm = true
    enable_integrity_monitoring = true
  }

  metadata = {
    enable-oslogin-2fa = "FALSE"
  }

  tags = ["maximum-uptime"]
}

resource "cloudflare_record" "oldboy" {
  zone_id = "6db37c857d0c3631bea427fab3301e89" # lolwtf.ca
  name = "oldboy.lolwtf.ca"
  type = "A"
  content = google_compute_instance.oldboy.network_interface[0].access_config[0].nat_ip
  proxied = true
}
