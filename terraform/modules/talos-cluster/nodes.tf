# Each patch is one talosctl --config-patch-<type> file, in this order.
# config_patches is what a running node gets; install_patches is the render
# for a fresh install, which the install_inputs output and the parity check
# use; fleet-controller renders the same from render_inputs.
locals {
  config_patches = { for name, n in var.nodes : name => concat(
    [local.cluster_patch],
    var.cluster_patches,
    n.role == "controlplane" ? concat([local.controlplane_patch], var.controlplane_patches) : [],
    [local.node_patch[name]],
    n.patches,
  ) }
  install_patches = { for name, n in var.nodes : name => concat(
    [local.cluster_patch],
    var.cluster_patches,
    n.role == "controlplane" ? concat([local.controlplane_patch], var.controlplane_patches) : [],
    [local.node_patch_install[name]],
    n.patches,
  ) }
}

# One rendered machine config per node, never in state (ephemeral + _wo).
ephemeral "talos_machine_configuration" "node" {
  for_each = var.nodes

  cluster_name       = local.topology.CLUSTER_NAME
  cluster_endpoint   = local.cluster_endpoint
  machine_type       = each.value.role
  machine_secrets    = local.machine_secrets
  talos_version      = var.talos_contract
  kubernetes_version = var.kubernetes_version
  config_patches     = local.config_patches[each.key]
}

# A changed install_generation replaces the node's talos_machine. Delete does
# nothing, and Create applies the config and upgrades only when the running
# version tag differs from the image's, so a new installer_image never
# reinstalls a running node.
resource "terraform_data" "install" {
  for_each = var.nodes

  input = each.value.install_generation

  lifecycle {
    # A static address outside the node prefix, or with no resolver, would
    # cut the node off at its next apply.
    precondition {
      condition = !var.static_addresses || (
        length(var.nameservers) > 0 &&
        cidrhost("${each.value.address}/${local.node_prefix_length}", 0) == cidrhost(local.topology.K8S_NODE_CIDR, 0)
      )
      error_message = "With static_addresses, every node's address must be in K8S_NODE_CIDR and nameservers must name a resolver."
    }
  }
}

# The bootstrap control plane is configured first; talos_cluster bootstraps
# etcd on it; the joining control planes and the workers follow. An image
# change upgrades in the same order.
resource "talos_machine" "controlplane" {
  for_each = local.bootstrap

  node                     = each.value.address
  client_configuration_wo  = ephemeral.talos_client_configuration.this.client_configuration
  machine_configuration_wo = ephemeral.talos_machine_configuration.node[each.key].machine_configuration
  image                    = local.node_installer_image[each.key]
  reboot_mode              = each.value.reboot_mode

  # One control plane: a drain would evict the pods pinned here by local-path
  # PVs for nothing, and the Talos root must not depend on the Kubernetes API.
  drain_on_upgrade = false

  # talos_cluster owns the five Kubernetes component images (upgrade-k8s).
  ignore_kubernetes_upgrade_drift = true

  timeouts = {
    create = "40m"
    update = "90m"
  }

  lifecycle {
    replace_triggered_by = [terraform_data.install[each.key]]
  }
}

resource "talos_cluster" "this" {
  depends_on = [talos_machine.controlplane]

  node                    = local.topology.API_SERVER_IP
  client_configuration_wo = ephemeral.talos_client_configuration.this.client_configuration
  kubernetes_version      = var.kubernetes_version

  timeouts = {
    create = "30m"
    update = "60m"
  }

  lifecycle {
    # API_SERVER_IP is the bootstrap control plane's own address (no VIP).
    precondition {
      condition     = length(local.bootstrap) == 1
      error_message = "One applied control plane's address must equal API_SERVER_IP in cluster-topology.json."
    }
  }
}

# A control plane other than the bootstrap one joins etcd through the cluster
# it serves, so it is configured after talos_cluster, like a worker.
resource "talos_machine" "joining" {
  for_each   = local.joining
  depends_on = [talos_cluster.this]

  node                     = each.value.address
  client_configuration_wo  = ephemeral.talos_client_configuration.this.client_configuration
  machine_configuration_wo = ephemeral.talos_machine_configuration.node[each.key].machine_configuration
  image                    = local.node_installer_image[each.key]
  reboot_mode              = each.value.reboot_mode
  drain_on_upgrade         = false

  ignore_kubernetes_upgrade_drift = true

  timeouts = {
    create = "40m"
    update = "90m"
  }

  lifecycle {
    replace_triggered_by = [terraform_data.install[each.key]]
  }
}

resource "talos_machine" "worker" {
  for_each   = local.workers
  depends_on = [talos_cluster.this]

  node                     = each.value.address
  client_configuration_wo  = ephemeral.talos_client_configuration.this.client_configuration
  machine_configuration_wo = ephemeral.talos_machine_configuration.node[each.key].machine_configuration
  image                    = local.node_installer_image[each.key]
  reboot_mode              = each.value.reboot_mode
  drain_on_upgrade         = false

  ignore_kubernetes_upgrade_drift = true

  timeouts = {
    create = "40m"
    update = "90m"
  }

  lifecycle {
    replace_triggered_by = [terraform_data.install[each.key]]
  }
}
