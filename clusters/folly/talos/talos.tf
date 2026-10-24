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
  default     = "a3jq5rtwm4b22eeht7jg6idtli"

  validation {
    condition     = can(regex("^[a-z0-9]{26}$", var.secrets_item_uuid))
    error_message = "Create the talos-folly-secrets Secure Note, then set secrets_item_uuid to its 26-character UUID."
  }
}

locals {
  # The vault the Atlantis 1Password service account reads.
  op_vault_homelab = "ib23znjeikv74p37f6mbfk7uya"

  node_addresses = jsondecode(module.topology.data.NODE_ADDRESSES)

  # renovate: datasource=github-releases depName=siderolabs/talos
  talos_version = "v1.14.2"

  # Signed with the lab's Secure Boot keys, with the extensions below. The
  # image build publishes one per Talos version, tagged with the version.
  secureboot_installer = "ghcr.io/jonpulsifer/talos-installer-folly:${local.talos_version}"

  # install is a CEL disk selector. ephemeral caps EPHEMERAL so that the
  # data user volume takes the rest of the one disk. A node with installer
  # boots the signed UKI; its generation changes when it is reinstalled from
  # new media.
  nodes = {
    optiplex = {
      role       = "controlplane"
      install    = "disk.dev_path == \"/dev/sda\""
      ephemeral  = "100GiB"
      installer  = local.secureboot_installer
      generation = "secureboot-1"
    }
    riptide = {
      role       = "worker"
      install    = "disk.dev_path == \"/dev/nvme0n1\""
      ephemeral  = "80GiB"
      installer  = local.secureboot_installer
      generation = "secureboot-1"
    }
    shale = { role = "worker", install = "disk.dev_path == \"/dev/sda\"", ephemeral = "128GiB" }
  }

  # Nodes whose STATE and EPHEMERAL the TPM unlocks. A node joins in the pull
  # request that reinstalls it: Talos records the STATE encryption in META
  # when the config applies, and a plain STATE then fails at the next boot.
  tpm_nodes = []
}

# shale has no install generation, so its record is imported rather than
# created: a created record would replace its talos_machine.
import {
  to = module.talos.terraform_data.install["shale"]
  id = "shale"
}

module "talos" {
  source = "../../../terraform/modules/talos-cluster"

  site = "folly"

  talos_version  = local.talos_version
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
    role               = n.role
    address            = local.node_addresses[name]
    install            = n.install
    patches            = [local.ephemeral_patch[name]]
    installer_image    = try(n.installer, null)
    install_generation = try(n.generation, null)
  } }
  tpm_nodes = local.tpm_nodes

  cluster_patches      = local.cluster_patches
  controlplane_patches = local.controlplane_patches
}

output "schematic_id" {
  description = "Image Factory schematic of folly's nodes without a signed installer. The kexec and PXE assets must use the same ID."
  value       = module.talos.schematic_id
}

output "installer_image" {
  description = "Installer image each folly node runs."
  value       = module.talos.node_installer_images
}

output "machine_inputs" {
  description = "Per node, the inputs of talosctl gen config other than the secrets bundle. The enrollment server renders a node's config from them."
  value       = module.talos.machine_inputs
}

output "nodes" {
  description = "Node name to address, as applied."
  value       = module.talos.nodes
}
