terraform {
  required_version = ">= 1.11"
  backend "gcs" {
    bucket = "homelab-ng"
    prefix = "clusters/offsite/talos"
  }
  required_providers {
    talos = {
      source  = "siderolabs/talos"
      version = "~> 0.12"
    }
    onepassword = {
      source  = "1Password/onepassword"
      version = "~> 3.0"
    }
  }
}

provider "talos" {}

# OP_SERVICE_ACCOUNT_TOKEN on Atlantis, or OP_ACCOUNT for the owner's sign-in.
provider "onepassword" {}

variable "secrets_item_uuid" {
  type        = string
  description = "UUID of the 1Password Secure Note talos-offsite-secrets, whose note is offsite's Talos secrets bundle. Issue a talosconfig names the item."
  default     = "kbtd3p7uw2rjbiiuflxdxr6njm"

  validation {
    condition     = can(regex("^[a-z0-9]{26}$", var.secrets_item_uuid))
    error_message = "Create the talos-offsite-secrets Secure Note, then set secrets_item_uuid to its 26-character UUID."
  }
}

locals {
  # The vault the Atlantis 1Password service account reads.
  op_vault_homelab = "ib23znjeikv74p37f6mbfk7uya"

  node_addresses = jsondecode(module.topology.data.NODE_ADDRESSES)

  # install is a CEL disk selector. ephemeral caps EPHEMERAL so that the
  # data user volume takes the rest of the one disk.
  #
  # hotrod is the sandbox node: Rowbutt's sandboxes, the ARC runners and the
  # kthx engine's in-cluster build Jobs select its label and tolerate its
  # taint, and the taint keeps every other pod off it.
  # generation changes when a node's recorded install must be re-created
  # without a reboot: the module re-creates its talos_machine, which upgrades
  # only when the running version differs from the image's.
  nodes = {
    retrofit = {
      role       = "controlplane"
      install    = "disk.dev_path == \"/dev/sda\""
      ephemeral  = "100GiB"
      generation = "v1.14.5-1"
    }
    oldschool = {
      role       = "worker"
      install    = "disk.dev_path == \"/dev/sda\""
      ephemeral  = "100GiB"
      generation = "v1.14.5-1"
    }
    hotrod = {
      role       = "worker"
      install    = "disk.dev_path == \"/dev/nvme0n1\""
      ephemeral  = "64GiB"
      generation = "v1.14.5-1"
      labels     = { "lolwtf.ca/sandbox" = "true" }
      taints     = { "lolwtf.ca/sandbox" = "true:NoSchedule" }
    }
  }
}

# Each node's install record is imported, not created. The generation set
# above then changes the record, which re-creates the node's talos_machine
# through Create: no reboot while the running version matches the image's.
import {
  for_each = local.nodes
  to       = module.talos.terraform_data.install[each.key]
  id       = each.key
}

module "talos" {
  source = "../../../terraform/modules/talos-cluster"

  site = "offsite"

  # renovate: datasource=github-releases depName=siderolabs/talos
  talos_version  = "v1.14.5"
  talos_contract = "v1.14"
  # renovate: datasource=docker depName=ghcr.io/siderolabs/kubelet
  kubernetes_version = "v1.36.3"

  # Order is part of the schematic ID, which the install media must match.
  # The same list as folly's, so both clusters share one schematic.
  extensions = [
    "siderolabs/gvisor",
    "siderolabs/i915",
    "siderolabs/intel-ucode",
    "siderolabs/kata-containers",
    "siderolabs/realtek-firmware",
  ]

  op_vault          = local.op_vault_homelab
  secrets_item_uuid = var.secrets_item_uuid

  nodes = { for name, n in local.nodes : name => {
    role    = n.role
    address = local.node_addresses[name]
    install = n.install
    patches = [local.ephemeral_patch[name]]
    labels  = try(n.labels, {})
    taints  = try(n.taints, {})

    install_generation = try(n.generation, null)
  } }

  cluster_patches      = local.cluster_patches
  controlplane_patches = local.controlplane_patches
}

output "schematic_id" {
  description = "Image Factory schematic of offsite's nodes. The kexec and PXE assets must use the same ID."
  value       = module.talos.schematic_id
}

output "installer_image" {
  description = "Installer image every offsite node runs."
  value       = module.talos.installer_image
}

output "nodes" {
  description = "Node name to address, as applied."
  value       = module.talos.nodes
}
