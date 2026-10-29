# The metal dev env: one spot VM with nested virtualization that runs nix/hosts/metal-dev.nix.
# Its own VPC admits SSH only through IAP; everything else reaches it over the tailnet.
module "network" {
  source = "../modules/gce-vpc"
  providers = {
    google      = google
    google-beta = google-beta
  }
  name              = "metal-dev"
  subnet_name       = "metal-dev"
  ip_cidr_range     = "10.13.38.0/28"
  ssh_firewall_name = "metal-dev-ssh"
}

resource "google_service_account" "vm" {
  account_id   = "metal-dev"
  display_name = "metal-dev VM"
}

# The nix-image-builder workflow uploads the metal-dev image under this prefix. Build names sort
# oldest first, so the newest image is the last name; with no upload yet there is no image and no VM.
# Nothing prunes the prefix: each upload is a multi-GB object, so delete old ones by hand.
data "google_storage_bucket_objects" "images" {
  bucket = "homelab-ng-free"
  prefix = "metal-dev/"
}

locals {
  image_object = try(reverse(sort([
    for o in data.google_storage_bucket_objects.images.bucket_objects : o.name
    if endswith(o.name, ".raw.tar.gz")
  ]))[0], null)
  have_image = local.image_object != null
}

data "google_storage_bucket_object" "image" {
  count = local.have_image ? 1 : 0

  bucket = "homelab-ng-free"
  name   = local.image_object
}

# Named by the object's content, so a rebuild that changes the object gets a new image and one
# that lands under a new name with the same content does not.
resource "google_compute_image" "nixos" {
  count = local.have_image ? 1 : 0

  name              = "metal-dev-${substr(sha1(data.google_storage_bucket_object.image[0].md5hash), 0, 8)}"
  family            = "metal-dev"
  storage_locations = [local.region]
  raw_disk {
    source = "https://storage.googleapis.com/homelab-ng-free/${local.image_object}"
  }
  guest_os_features {
    type = "UEFI_COMPATIBLE"
  }
  guest_os_features {
    type = "GVNIC"
  }
}

# The disk holds every secret, the NetBox database and the virtual nodes. A new image never
# replaces it: the running system upgrades itself from main, as every host does. To start over,
# snapshot it, remove prevent_destroy, and apply; the README has the steps.
resource "google_compute_disk" "boot" {
  count = var.on && local.have_image ? 1 : 0

  name  = "metal-dev"
  image = google_compute_image.nixos[0].self_link
  size  = var.disk_gb
  type  = "pd-balanced"

  lifecycle {
    ignore_changes  = [image]
    prevent_destroy = true
  }
}

resource "google_compute_instance" "metal_dev" {
  count = var.on && local.have_image ? 1 : 0

  name                      = "metal-dev"
  description               = "Nested-virtualization stand-in for folly's bootstrap VLAN and a rack of nodes"
  machine_type              = var.machine_type
  allow_stopping_for_update = true

  # Created stopped. scripts/metal-dev/up.sh and down.sh start and stop it, so the state is not
  # desired state here.
  desired_status = "TERMINATED"

  boot_disk {
    auto_delete = false
    source      = google_compute_disk.boot[0].self_link
  }

  network_interface {
    network    = module.network.network.self_link
    subnetwork = module.network.subnet.self_link
    access_config {}
  }

  scheduling {
    provisioning_model          = "SPOT"
    preemptible                 = true
    automatic_restart           = false
    on_host_maintenance         = "TERMINATE"
    instance_termination_action = "STOP"
  }

  advanced_machine_features {
    enable_nested_virtualization = true
  }

  # Secure Boot is off, as on oldboy: GCE's firmware rejects the unsigned NixOS bootloader.
  shielded_instance_config {
    enable_secure_boot          = false
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }

  service_account {
    email  = google_service_account.vm.email
    scopes = ["cloud-platform"]
  }

  metadata = {
    enable-oslogin = "FALSE"
  }

  lifecycle {
    ignore_changes = [desired_status]
  }
}
