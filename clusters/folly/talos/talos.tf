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
  machines       = yamldecode(file("${path.module}/../inventory/machines.yaml")).machines

  # renovate: datasource=github-releases depName=siderolabs/talos
  talos_version = "v1.14.4"

  # Signed with the lab's Secure Boot keys, with the extensions below. The
  # image build publishes one per Talos version, tagged with the version.
  secureboot_installer = "ghcr.io/jonpulsifer/talos-installer-folly:${local.talos_version}"

  # Git declares classes; NetBox declares which machine is of which class, in
  # the inventory export's class key. ephemeral caps EPHEMERAL so that the
  # data user volume takes the rest of the one disk. Every class boots the
  # signed UKI; the generation changes when a class is reinstalled from new
  # media. The enrollment server renders a node of a class from the
  # class_inputs output below.
  classes = {
    controlplane = {
      role      = "controlplane"
      ephemeral = "100GiB"
    }
    worker-g5 = {
      role      = "worker"
      ephemeral = "80GiB"
    }
    worker-g2 = {
      role      = "worker"
      ephemeral = "128GiB"
    }
  }
  install_generation = "secureboot-1"

  # The nodes are the export's active, staged and failed machines: a failed
  # one is quarantined, not gone, and stays managed. A staged worker is
  # enrolling: the server renders its config and the root applies none until
  # NetBox holds it active, so its talos_machine is planned away and back
  # across a reinstall, by design. The one control plane is never enrolling,
  # or the root would have no control plane to bootstrap and apply through.
  # The install disk is the inventory's.
  nodes = { for name, m in local.machines : name => {
    class     = m.class
    role      = local.classes[m.class].role
    enrolling = m.status == "staged" && local.classes[m.class].role != "controlplane"
  } if contains(["active", "staged", "failed"], m.status) }

  # The inventory's TPM 2.0 nodes, which seal disks and attest.
  tpm_nodes = sort([for name, m in local.machines : name if m.tpm == "2.0" && contains(keys(local.nodes), name)])

  # A TPM node's running STATE and EPHEMERAL are encrypted, except these, which
  # were installed with plain volumes and keep them until a reinstall. Talos
  # refuses to mount a plain volume that its config calls encrypted.
  plain_nodes     = ["optiplex"]
  encrypted_nodes = [for name in local.tpm_nodes : name if !contains(local.plain_nodes, name)]

  # What the enrollment server renders a fresh install from, per class: the
  # module's patch lists in order, the node document rendered by the server
  # between them, then the class's own. mise run render-class-inputs writes
  # it to clusters/folly/apps/talos-enroll/class-inputs.json.
  class_inputs = { for class, c in local.classes : class => {
    machine_type       = c.role
    cluster_name       = module.talos.render_inputs.cluster_name
    cluster_endpoint   = module.talos.render_inputs.cluster_endpoint
    talos_contract     = module.talos.render_inputs.talos_contract
    kubernetes_version = module.talos.render_inputs.kubernetes_version
    installer_image    = local.secureboot_installer
    dns_zone           = module.talos.render_inputs.dns_zone
    config_patches = concat(
      module.talos.render_inputs.cluster_patches,
      c.role == "controlplane" ? module.talos.render_inputs.controlplane_patches : [],
    )
    tpm_patches   = module.talos.render_inputs.tpm_patches
    class_patches = [local.ephemeral_patch[class]]
    labels        = {}
    tpm_labels    = module.talos.render_inputs.tpm_labels
  } }
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
    install            = "disk.dev_path == \"${local.machines[name].disk}\""
    patches            = [local.ephemeral_patch[n.class]]
    installer_image    = local.secureboot_installer
    install_generation = local.install_generation
    enrolling          = n.enrolling
  } }
  tpm_nodes       = local.tpm_nodes
  encrypted_nodes = local.encrypted_nodes

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

output "class_inputs" {
  description = "Per class, the inputs of talosctl gen config other than the node's own documents and the secrets. The enrollment server renders a node's config from its class's entry and NetBox's facts about the node."
  value       = local.class_inputs
}

output "nodes" {
  description = "Node name to address, as applied."
  value       = module.talos.nodes
}
