module "network" {
  source = "github.com/jonpulsifer/terraform-modules/gce-vpc"
  providers = {
    google      = google.free-tier
    google-beta = google-beta.free-tier
  }
  name          = "vpc"
  subnet_name   = "computers"
  ip_cidr_range = "10.13.37.0/28"
}

resource "google_service_account" "vm" {
  account_id   = "oldboy"
  display_name = "Old Boy VM Service Account"
}

data "cloudflare_ip_ranges" "cloudflare" {}

data "google_storage_bucket_objects" "files" {
  bucket = "homelab-ng-free"
  prefix = "nixos-image-google-compute"
}

resource "google_compute_image" "nixos" {
  provider          = google.free-tier
  name              = "nixos"
  family            = "nixos"
  storage_locations = ["us-east1"]
  raw_disk {
    source = "https://storage.googleapis.com/homelab-ng-free/${data.google_storage_bucket_objects.files.bucket_objects[0].name}"
  }
  guest_os_features {
    type = "UEFI_COMPATIBLE"
  }
}

resource "google_compute_disk" "oldboy" {
  provider = google.free-tier
  name     = "oldboy"
  image    = google_compute_image.nixos.self_link
  size     = 16
  type     = "pd-standard"
}

resource "google_compute_instance" "oldboy" {
  provider                  = google.free-tier
  name                      = "oldboy"
  description               = "Old Boy VM to race with Pat"
  machine_type              = "e2-micro"
  allow_stopping_for_update = true
  boot_disk {
    auto_delete = true
    source      = google_compute_disk.oldboy.self_link
  }
  network_interface {
    network    = module.network.network.self_link
    subnetwork = module.network.subnet.self_link

  }

  service_account {
    email  = google_service_account.vm.email
    scopes = ["cloud-platform"]
  }

  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }

  metadata = {
    enable-oslogin-2fa = "FALSE"
  }

  tags = ["maximum-uptime"]
}

