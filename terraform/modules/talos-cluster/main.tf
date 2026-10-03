# Talos machine config for one cluster, applied over the Talos API (50000).
# No Kubernetes provider: this root must work while the cluster is down.

module "topology" {
  source = "../cluster-topology"
  site   = var.site
}

locals {
  topology         = module.topology.data
  cluster_endpoint = "https://${local.topology.API_SERVER_HOSTNAME}:${local.topology.API_SERVER_PORT}"
  controlplanes    = { for name, n in var.nodes : name => n if n.role == "controlplane" }
  workers          = { for name, n in var.nodes : name => n if n.role == "worker" }
  controlplane     = one(values(local.controlplanes))
}

# The secrets bundle is a 1Password Secure Note whose note is secrets.yaml
# (the `talosctl gen secrets` shape, with the imported FML keys). Ephemeral:
# never in plan or state. The provider's ephemeral item (v3.3.1) exposes
# note_value but no sections or files, which is why it is a note. Its os CA
# is also what mints the os:admin client certificate below.
ephemeral "onepassword_item" "secrets" {
  vault = var.op_vault
  uuid  = var.secrets_item_uuid
}

locals {
  bundle = yamldecode(ephemeral.onepassword_item.secrets.note_value)

  # talosctl's YAML keys to the provider's machine_secrets attribute names.
  # Values stay base64 PEM, as in secrets.yaml.
  machine_secrets = {
    cluster = {
      id     = local.bundle.cluster.id
      secret = local.bundle.cluster.secret
    }
    secrets = {
      bootstrap_token             = local.bundle.secrets.bootstraptoken
      secretbox_encryption_secret = local.bundle.secrets.secretboxencryptionsecret
    }
    trustdinfo = {
      token = local.bundle.trustdinfo.token
    }
    certs = {
      etcd               = { cert = local.bundle.certs.etcd.crt, key = local.bundle.certs.etcd.key }
      k8s                = { cert = local.bundle.certs.k8s.crt, key = local.bundle.certs.k8s.key }
      k8s_aggregator     = { cert = local.bundle.certs.k8saggregator.crt, key = local.bundle.certs.k8saggregator.key }
      k8s_serviceaccount = { key = local.bundle.certs.k8sserviceaccount.key }
      os                 = { cert = local.bundle.certs.os.crt, key = local.bundle.certs.os.key }
    }
  }
}

# os:admin credentials derived from the bundle on every run. With not_before
# unset the certificate carries the os CA's own validity, so nothing rotates.
ephemeral "talos_client_configuration" "this" {
  cluster_name    = local.topology.CLUSTER_NAME
  machine_secrets = local.machine_secrets
  endpoints       = [for n in local.controlplanes : n.address]
}

# Image Factory schematic: the extension set is part of the node's identity.
# An upgrade that drops it drops the extensions.
resource "talos_image_factory_schematic" "this" {
  schematic = yamlencode({
    customization = {
      systemExtensions = {
        officialExtensions = var.extensions
      }
      extraKernelArgs = var.extra_kernel_args
    }
  })
}

locals {
  installer_image = "factory.talos.dev/metal-installer/${talos_image_factory_schematic.this.id}:${var.talos_version}"
}
