terraform {
  required_version = ">= 1.11"
  backend "gcs" {
    bucket = "homelab-ng"
    prefix = "clusters/folly/talos"
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
  description = "UUID of the 1Password Secure Note talos-folly-secrets, whose note is folly's Talos secrets bundle. Issue a talosconfig names the item."
  default     = "PLACEHOLDER-create-talos-folly-secrets"

  validation {
    condition     = can(regex("^[a-z0-9]{26}$", var.secrets_item_uuid))
    error_message = "Create the talos-folly-secrets Secure Note, then set secrets_item_uuid to its 26-character UUID."
  }
}

locals {
  # The vault the Atlantis 1Password service account reads.
  op_vault_homelab = "ib23znjeikv74p37f6mbfk7uya"

  node_addresses = jsondecode(module.topology.data.NODE_ADDRESSES)

  # install is a CEL disk selector. ephemeral caps EPHEMERAL so that the
  # data user volume takes the rest of the one disk.
  nodes = {
    optiplex = { role = "controlplane", install = "disk.dev_path == \"/dev/sda\"", ephemeral = "100GiB" }
    riptide  = { role = "worker", install = "disk.dev_path == \"/dev/nvme0n1\"", ephemeral = "80GiB" }
    shale    = { role = "worker", install = "disk.dev_path == \"/dev/sda\"", ephemeral = "128GiB" }
  }
}

module "talos" {
  source = "../../../terraform/modules/talos-cluster"

  site = "folly"

  # renovate: datasource=github-releases depName=siderolabs/talos
  talos_version  = "v1.14.2"
  talos_contract = "v1.14"
  # renovate: datasource=docker depName=ghcr.io/siderolabs/kubelet
  kubernetes_version = "v1.36.3"

  # Order is part of the schematic ID, which the install media must match.
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
  } }

  cluster_patches      = local.cluster_patches
  controlplane_patches = local.controlplane_patches
}

output "schematic_id" {
  description = "Image Factory schematic of folly's nodes. The kexec and PXE assets must use the same ID."
  value       = module.talos.schematic_id
}

output "installer_image" {
  description = "Installer image every folly node runs."
  value       = module.talos.installer_image
}

output "nodes" {
  description = "Node name to address, as applied."
  value       = module.talos.nodes
}
