# tender: the cloud bosun host, running the same warm pool riptide does but
# off the folly cluster entirely.
#
# C4 is the machine family because nested virtualization on Compute Engine is
# Intel-only -- every AMD (`D`) and Arm (`A`/Axion) family is excluded outright
# -- and among the Intel families C4 is the highest clocked: Granite Rapids at
# a 3.9 GHz sustained all-core turbo, 4.2 GHz max. That is the whole reason to
# run CI here rather than on a cheaper N2.
#
# Nested virt itself is a plain boolean on the instance. It needs no custom
# image and no `enable-vmx` license, so nix/images/gce.nix is unchanged from
# what oldboy boots.
#
# Bare metal was weighed and rejected: the smallest x86 metal SKU GCE sells is
# 192 vCPU at ~$8.67/hr, it forces an IDPF-only NIC and a TERMINATE maintenance
# policy, and it buys back only the ~10% nested-virt tax.

locals {
  # The one knob worth turning while measuring. Changing family means
  # re-checking the nested-virt column, not just the price.
  tender_machine_type = "c4-standard-8" # 8 vCPU / 30 GB
  tender_disk_size    = 100             # closure + hull + warm x workspace
}

# No IAM role bindings anywhere: this host needs nothing from GCP beyond
# writing its own logs. Skiffs cannot reach the metadata server at all --
# bosun's unit denies 169.254.0.0/16 and every skiff inherits the filter --
# but the host can, so the scope is kept to the one thing it uses.
resource "google_service_account" "tender" {
  account_id   = "tender"
  display_name = "tender (cloud bosun host) VM Service Account"
}

# Published by .github/workflows/nix-image-builder.yaml under its own prefix.
# `gce` and `oldboy` both write the same nixpkgs-generated filename to the
# bucket root and clobber each other; tender stays out of that.
data "google_storage_bucket_objects" "tender" {
  bucket = "homelab-ng-free"
  prefix = "tender/nixos-image-google-compute"
}

# Everything below rides the `free-tier` alias -- us-east1-b -- with the rest of
# this root, and so lands on the module's existing subnet. Montreal sells C4 and
# would otherwise have been the closer region, but this project's C4 quota there
# is 0 while us-east1 already carries 24: `CPUS-PER-VM-FAMILY-per-project-region`
# is dimensioned by region, and a zero is a support request, not a terraform
# change.
resource "google_compute_image" "tender" {
  provider          = google.free-tier
  name              = "tender"
  family            = "tender"
  storage_locations = ["us-east1"]
  raw_disk {
    source = "https://storage.googleapis.com/homelab-ng-free/${data.google_storage_bucket_objects.tender.bucket_objects[0].name}"
  }
  guest_os_features {
    type = "UEFI_COMPATIBLE"
  }
  # C4 is gVNIC-only -- Granite Rapids does not offer virtio-net -- so GCE sets
  # the interface's NicType to GVNIC on its own and then rejects the instance
  # if the image has not declared it can drive one. The kernel can: CONFIG_GVE
  # is a module, udev autoloads it by PCI id, and google-compute-config.nix
  # turns off predictable interface names, so it still arrives as eth0.
  guest_os_features {
    type = "GVNIC"
  }
}

# C4 is Hyperdisk-only; Persistent Disk is not offered on the newest families.
#
# ignore_changes on `image` is load-bearing, not caution. sops-nix decrypts
# with this host's own SSH host key, which lives on this disk -- so replacing
# the disk on every image rebuild would invalidate nix/secrets/tender.sops.yaml
# every time. The host carries itself forward with nixos-upgrade from main the
# same way every other fleet host does; the image is a birth certificate, not a
# deploy channel.
#
# The cost of that: a disk copies the image's guest_os_features when it is
# created and never revisits them, and the image's self_link does not change
# when the image is replaced under the same name -- so a change to the features
# above produces no diff here at all. Replacing an existing disk to pick them up
# is a deliberate `-replace`, and only ever safe before first boot, while there
# is no host key on it yet.
resource "google_compute_disk" "tender" {
  provider = google.free-tier
  name     = "tender"
  image    = google_compute_image.tender.self_link
  size     = local.tender_disk_size
  type     = "hyperdisk-balanced"

  lifecycle {
    ignore_changes = [image]
  }
}

resource "google_compute_instance" "tender" {
  provider                  = google.free-tier
  name                      = "tender"
  description               = "Cloud bosun host: a warm pool of microVM Actions runners"
  machine_type              = local.tender_machine_type
  allow_stopping_for_update = true

  # The point of the whole exercise: a skiff is a KVM guest inside this guest.
  advanced_machine_features {
    enable_nested_virtualization = true
  }

  # Spot, because a measurement box that idles overnight should not be billed
  # like a server. instance_termination_action = STOP keeps the boot disk on a
  # preemption, so the host key -- and every sops secret encrypted to it --
  # survives; the instance comes back with `gcloud compute instances start`.
  #
  # ponytail: nothing restarts it automatically. A preemption empties the pool
  # until someone notices. A size-1 MIG with autohealing is the upgrade if this
  # stops being a science box.
  scheduling {
    provisioning_model          = "SPOT"
    preemptible                 = true
    automatic_restart           = false
    on_host_maintenance         = "TERMINATE"
    instance_termination_action = "STOP"
  }

  boot_disk {
    auto_delete = false
    source      = google_compute_disk.tender.self_link
  }

  # An ephemeral external IP rather than Cloud NAT: CI reaches github.com,
  # ghcr.io, cache.nixos.org and half a dozen other public hosts, and a NAT
  # gateway costs ~10x an IPv4 address for one instance. Ingress is still
  # default-deny -- the VPC is custom-mode and the only rule in it is the
  # module's IAP-range SSH allow.
  network_interface {
    network    = module.network.network.self_link
    subnetwork = module.network.subnet.self_link
    access_config {}
  }

  service_account {
    email  = google_service_account.tender.email
    scopes = ["https://www.googleapis.com/auth/logging.write"]
  }

  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }

  metadata = {
    enable-oslogin-2fa = "FALSE"
  }
}

output "tender_external_ip" {
  description = "tender's ephemeral external address, for the first-boot SSH that seeds its sops recipient."
  value       = google_compute_instance.tender.network_interface[0].access_config[0].nat_ip
}
