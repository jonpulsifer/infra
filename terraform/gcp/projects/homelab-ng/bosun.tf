# The cloud bosun fleet: hosts that keep a warm pool of skiffs off the folly
# cluster entirely. One instance per silicon generation, because the question
# this fleet exists to answer is which silicon serves CI best per dollar, and
# a single machine type cannot answer it.
#
# Every family here is Intel. Nested virtualization on Compute Engine excludes
# E2, memory-optimized, H4D, and every AMD (`D`) and Arm (`A`/Axion) family
# outright, which is the whole reason C4D -- 384 cores of Turin, the fastest
# thing in the price list -- cannot serve a skiff as a VM at any size.
#
# Nested virt is a plain boolean on the instance. It needs no custom image and
# no `enable-vmx` license, so nix/images/gce.nix is unchanged from what oldboy
# boots.
#
# Bare metal: weighed twice, and now measured and refused. GCE does not sell
# metal as Spot at all -- "Spot VMs don't support the following machines: The
# A4X machine series, Bare metal instances" -- so metal is on-demand only, at
# $8.67/hr for the smallest x86 SKU (c3-highcpu-192-metal, 192 vCPU / 512 GB).
# It is also indivisible: 192 vCPU is the floor, and this project's C3 quota in
# us-east1 auto-approved 24 -> 150 and then denied 192 twice, so a single
# instance does not fit and only a human support case could change that. What
# metal buys back is the ~10% nested-virt tax. Do not re-chase it; the image
# side is already free if it ever changes (CONFIG_IDPF=m in the kernel we ship,
# and the IDPF + BARE_METAL_LINUX_COMPATIBLE guest OS features both exist --
# metal would need the vTPM block dropped, since bare metal has no vTPM).
locals {
  # The knob worth turning. Changing family means re-checking the nested-virt
  # column and the disk type, not just the price.
  #
  # Sizes are deliberately modest: warm-pool depth across the fleet is what
  # beats a hosted runner, not depth on any one host. Spot rates, us-east1:
  #   C3  $0.00981/core  $0.001115/GB   Sapphire Rapids, 3.0 GHz all-core
  #   C4  $0.02079/core  $0.002363/GB   Granite Rapids,  3.9 GHz all-core
  #   N2  $0.01814/core  $0.002432/GB   Cascade/Ice Lake
  # C3 cores are half the price of everything else, which is why the cheapest
  # host in the fleet is also the widest.
  bosun_fleet = {
    # The C4 baseline. Every number in apps/bosun/README.md was measured on
    # this silicon, so it is the row the others are read against.
    tender = {
      machine_type = "c4-standard-16"     # 16 vCPU / 60 GB, ~$0.47/hr Spot
      disk_size    = 130                  # 4x6G + 20G workspace + 30G cache + closure
      disk_type    = "hyperdisk-balanced" # C4 is Hyperdisk-only
      description  = "Cloud bosun host: Granite Rapids, the fleet's speed baseline"
    }
    # The value play: half-price cores, 30% slower each. Widest pool here.
    dinghy = {
      machine_type = "c3-standard-22" # 22 vCPU / 88 GB, ~$0.31/hr Spot
      disk_size    = 150              # 6x6G + 20G workspace + 30G cache + closure
      disk_type    = "hyperdisk-balanced"
      description  = "Cloud bosun host: Sapphire Rapids, the cheapest core in the price list"
    }
    # The commodity floor: what a warm pool costs on the family everyone
    # already has quota for.
    launch = {
      machine_type = "n2-standard-16" # 16 vCPU / 64 GB, ~$0.45/hr Spot
      disk_size    = 130              # 4x6G + 20G workspace + 30G cache + closure
      disk_type    = "pd-balanced"    # N2 predates Hyperdisk; PD is the safe default
      description  = "Cloud bosun host: the commodity N2 workhorse"
    }
  }
}

# No IAM role bindings anywhere: these hosts need nothing from GCP beyond
# writing their own logs. Skiffs cannot reach the metadata server at all --
# bosun's unit denies 169.254.0.0/16 and every skiff inherits the filter --
# but the host can, so the scope is kept to the one thing it uses.
resource "google_service_account" "bosun" {
  for_each     = local.bosun_fleet
  account_id   = each.key
  display_name = "${each.key} (cloud bosun host) VM Service Account"
}

# Published by .github/workflows/nix-image-builder.yaml under each host's own
# prefix. `gce` and `oldboy` both write the same nixpkgs-generated filename to
# the bucket root and clobber each other; these stay out of that.
data "google_storage_bucket_objects" "bosun" {
  for_each = local.bosun_fleet
  bucket   = "homelab-ng-free"
  prefix   = "${each.key}/nixos-image-google-compute"
}

# GCS lists objects lexicographically, so element zero is the *oldest* name the
# moment a prefix holds more than one build -- not a race, just reliably the
# wrong one. The nixpkgs filename carries version and commit date in sort
# order, so the newest image is the last element.
locals {
  bosun_image_objects = {
    for name, _ in local.bosun_fleet :
    name => reverse(sort([
      for o in data.google_storage_bucket_objects.bosun[name].bucket_objects : o.name
    ]))[0]
  }
}

# Everything below rides the `free-tier` alias -- us-east1 -- with the rest of
# this root, and so lands on the module's existing subnet. That subnet is a
# /28: oldboy plus this fleet is four addresses of thirteen usable.
resource "google_compute_image" "bosun" {
  for_each          = local.bosun_fleet
  provider          = google.free-tier
  name              = each.key
  family            = each.key
  storage_locations = ["us-east1"]
  raw_disk {
    source = "https://storage.googleapis.com/homelab-ng-free/${local.bosun_image_objects[each.key]}"
  }
  guest_os_features {
    type = "UEFI_COMPATIBLE"
  }
  # C4 is gVNIC-only -- Granite Rapids does not offer virtio-net -- so GCE sets
  # the interface's NicType to GVNIC on its own and then rejects the instance
  # if the image has not declared it can drive one. C3 and N2 accept gVNIC too,
  # so the feature is declared uniformly rather than per family. The kernel
  # can: CONFIG_GVE is a module, udev autoloads it by PCI id, and
  # google-compute-config.nix turns off predictable interface names, so it
  # still arrives as eth0.
  guest_os_features {
    type = "GVNIC"
  }
}

# ignore_changes on `image` is load-bearing, not caution. sops-nix decrypts
# with each host's own SSH host key, which lives on this disk -- so replacing
# the disk on every image rebuild would invalidate nix/secrets/<host>.sops.yaml
# every time. Hosts carry themselves forward with nixos-upgrade from main the
# same way every other fleet host does; the image is a birth certificate, not a
# deploy channel.
#
# The cost of that: a disk copies the image's guest_os_features when it is
# created and never revisits them, and the image's self_link does not change
# when the image is replaced under the same name -- so a change to the features
# above produces no diff here at all. Replacing an existing disk to pick them
# up is a deliberate `-replace`, and only ever safe before first boot, while
# there is no host key on it yet.
resource "google_compute_disk" "bosun" {
  for_each = local.bosun_fleet
  provider = google.free-tier
  name     = each.key
  image    = google_compute_image.bosun[each.key].self_link
  size     = each.value.disk_size
  type     = each.value.disk_type

  lifecycle {
    ignore_changes = [image]
  }
}

resource "google_compute_instance" "bosun" {
  for_each                  = local.bosun_fleet
  provider                  = google.free-tier
  name                      = each.key
  description               = each.value.description
  machine_type              = each.value.machine_type
  allow_stopping_for_update = true

  # The point of the whole exercise: a skiff is a KVM guest inside this guest.
  advanced_machine_features {
    enable_nested_virtualization = true
  }

  # Spot, because measurement boxes that idle overnight should not be billed
  # like servers. instance_termination_action = STOP keeps the boot disk on a
  # preemption, so the host key -- and every sops secret encrypted to it --
  # survives; the instance comes back with `gcloud compute instances start`.
  #
  # ponytail: nothing restarts them automatically. A preemption empties that
  # host's pool until someone notices, and with three hosts it is now three
  # times as likely that one is down. A size-1 MIG with autohealing per host is
  # the upgrade if this stops being a science fleet.
  scheduling {
    provisioning_model          = "SPOT"
    preemptible                 = true
    automatic_restart           = false
    on_host_maintenance         = "TERMINATE"
    instance_termination_action = "STOP"
  }

  boot_disk {
    auto_delete = false
    source      = google_compute_disk.bosun[each.key].self_link
  }

  # An ephemeral external IP rather than Cloud NAT: CI reaches github.com,
  # ghcr.io, cache.nixos.org and half a dozen other public hosts, and a NAT
  # gateway costs ~10x an IPv4 address per instance. Ingress is still
  # default-deny -- the VPC is custom-mode and the only rule in it is the
  # module's IAP-range SSH allow.
  network_interface {
    network    = module.network.network.self_link
    subnetwork = module.network.subnet.self_link
    access_config {}
  }

  service_account {
    email  = google_service_account.bosun[each.key].email
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

output "bosun_external_ips" {
  description = "Each cloud bosun host's ephemeral external address, for the first-boot SSH that seeds its sops recipient."
  value = {
    for name, inst in google_compute_instance.bosun :
    name => inst.network_interface[0].access_config[0].nat_ip
  }
}
