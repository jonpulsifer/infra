# tender: the cloud bosun host, running the same warm pool riptide does but
# off the folly cluster entirely.
#
# C4 is the machine family because nested virtualization on Compute Engine is
# Intel-only -- every AMD (`D`) and Arm (`A`/Axion) family is excluded outright,
# which is why C4D's 384 cores of Turin cannot serve a skiff as a VM at any
# size.
#
# Which Intel generation a C4 lands on is decided by the shape, not by a
# request: the `-lssd` and `-metal` variants and the 144- and 288-vCPU sizes
# get Granite Rapids, and every other C4 gets Emerald. `min_cpu_platform`
# cannot argue with it -- C4 rejects the field outright, and trying it stopped
# the instance and left it TERMINATED.
#
# Plain `c4-standard-48` therefore ran Emerald: a Xeon 8581C at 2.30 GHz base.
# `-lssd` is the same 48 vCPU and the same quota footprint and does get
# Granite, so the clock is bought by asking for the disk.
#
# It was worth buying because the profile said so rather than because the
# datasheet did. Sampling the host through an eight-wide run: the boot disk
# saturates for one ~60 s window during eight simultaneous checkouts and
# installs (419 of 440 MB/s, 91% utilisation) and then sits at **2-3%** for the
# five minutes the suite actually runs, while load holds near 10-12 against 48
# threads. Neither disk nor cores are the constraint in the phase that costs
# the time; it is single-threaded latency, per-test schema create/drop against
# a `fsync=off` database. Clock is the only hardware lever that touches that,
# and the bundled NVMe takes the burst that is left.
#
# Nested virt itself is a plain boolean on the instance. It needs no custom
# image and no `enable-vmx` license, so nix/images/gce.nix is unchanged from
# what oldboy boots.
#
# Bare metal: weighed twice, then measured and refused. GCE does not sell metal
# as Spot at all -- "Spot VMs don't support the following machines: The A4X
# machine series, Bare metal instances" -- so metal is on-demand only, at
# $8.67/hr for the smallest x86 SKU (c3-highcpu-192-metal, 192 vCPU / 512 GB).
# It is also indivisible: 192 vCPU is the floor, and this project's C3 quota in
# us-east1 auto-approved 24 -> 150 and then denied 192 twice, so one instance
# does not fit and only a human support case could change that. What metal buys
# back is the ~10% nested-virt tax. Do not re-chase it. The image side is
# already free if it ever changes: CONFIG_IDPF=m in the kernel we ship, and the
# IDPF and BARE_METAL_LINUX_COMPATIBLE guest OS features both exist -- metal
# would need the vTPM block below dropped, since bare metal has no vTPM.
locals {
  # The one knob worth turning while measuring. Changing family means
  # re-checking the nested-virt column, not just the price.
  #
  # 48 of the 50 C4 vCPU this project has in us-east1, which is what makes the
  # warm pool eight jobs wide. Spot rates here are $0.02079/core and
  # $0.002363/GB -- ~$1.42/hr -- and the `-lssd` variant adds eight bundled
  # NVMe partitions (~3 TB) at roughly $0.05/GB-month Spot, so call the host
  # ~$1.65/hr. `CPUS-PER-VM-FAMILY-per-project-region` is dimensioned by
  # region; Montreal sells C4 and would be closer, but its quota here is 0, and
  # a zero is a support request rather than a terraform change.
  #
  # The local SSDs are bundled by the machine type rather than attached here:
  # the shape reports `bundledLocalSsds`, so GCE provides them and no
  # `scratch_disk` block declares them. Nothing mounts them yet -- that is a
  # host-config change, and until it lands this shape is bought for the clock.
  tender_machine_type = "c4-standard-48-lssd" # 48 vCPU / 180 GB + ~3 TB NVMe
  tender_disk_size    = 200                   # closure + hull + 30G cache + 40G buildkit + 8x6G and 1x20G workspace

  # GCS lists objects lexicographically, so element zero is the *oldest* name
  # the moment the prefix holds more than one build -- not a race, just
  # reliably the wrong one. The nixpkgs filename carries version and commit
  # date in sort order, so the newest image is the last element.
  tender_image_object = reverse(sort([
    for o in data.google_storage_bucket_objects.tender.bucket_objects : o.name
  ]))[0]
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
# this root, and so lands on the module's existing subnet.
resource "google_compute_image" "tender" {
  provider          = google.free-tier
  name              = "tender"
  family            = "tender"
  storage_locations = ["us-east1"]
  raw_disk {
    source = "https://storage.googleapis.com/homelab-ng-free/${local.tender_image_object}"
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

  # No min_cpu_platform: C4 rejects it outright ("C4 VM does not support
  # minCpuPlatform Intel Granite Rapids", HTTP 400). Which generation a C4
  # lands on is a property of the shape, not a request -- see the note above
  # the machine type.

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

  # Secure Boot off, and it is not a shortcut. nix/images/gce.nix builds an EFI
  # image, and nothing signs the NixOS bootloader with a key GCE's UEFI db
  # trusts, so the firmware rejects it and loops on the boot entry forever:
  #
  #   BdsDxe: failed to load Boot0001 ... Status: Security Violation
  #
  # oldboy has been in that loop, "RUNNING" and unbooted, since it was created.
  # vTPM and integrity monitoring stay on; they measure the boot either way.
  # Turning this back on means signing the bootloader (lanzaboote) and putting
  # the certificate in the image, which is a project, not a flag.
  shielded_instance_config {
    enable_secure_boot          = false
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
