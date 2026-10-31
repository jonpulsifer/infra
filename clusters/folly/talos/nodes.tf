# The machines: each node in clusters/folly/inventory/nodes.yaml with its
# model's defaults, and its lifecycle status, which NetBox holds. Only a status
# other than active or failed drops a node; a declared node with no NetBox
# device fails the plan instead (data.netbox_devices.nodes).
locals {
  inventory = yamldecode(file("${path.module}/../inventory/nodes.yaml"))
  # Nodes whose TPM 2.0 the running node does not expose (no /dev/tpmrm0). The
  # root treats them as having no TPM: no lolwtf.ca/tpm label, so spire-agent
  # and tpm-reattest skip them, and no TPM patches. NetBox keeps the hardware's
  # tpm_version. Drop a node from here when its TPM is back.
  tpm_off = ["optiplex"]
  declared = { for name, n in local.inventory.nodes : name => merge(
    { for k, v in local.inventory.models[n.model] : k => v if contains(["disk", "tpm", "amt", "secure_boot"], k) },
    n,
    contains(local.tpm_off, name) ? { tpm = "off" } : {},
  ) }
  node_status = { for d in data.netbox_devices.nodes.devices : d.name => d.status }
  machines = { for name, m in local.declared : name => merge(m, {
    status = local.node_status[name]
  }) }
}

# The token is the credential of the API Credential item that
# terraform/netbox/folly reads too.
ephemeral "onepassword_item" "netbox" {
  vault = local.op_vault_homelab
  title = "netbox-folly-terraform"
}

# NetBox on capsule serves its API on capsule's Anchor network address,
# which NetBox's ALLOWED_HOSTS admits (nix/services/netbox.nix).
provider "netbox" {
  server_url = "http://${module.anchor_topology.data.CAPSULE_IP}:8080"
  api_token  = ephemeral.onepassword_item.netbox.credential
}

data "netbox_site" "folly" {
  slug = "folly"
}

data "netbox_device_role" "node" {
  name = "kubernetes-node"
}

data "netbox_devices" "nodes" {
  filter {
    name  = "site_id"
    value = data.netbox_site.folly.id
  }
  filter {
    name  = "role_id"
    value = data.netbox_device_role.node.id
  }

  # A restored or renamed NetBox, or a filter that matches nothing, must not
  # plan a running node's talos_machine away. A new node's device comes from
  # terraform/netbox/folly: apply that root before this one plans the entry.
  lifecycle {
    postcondition {
      condition     = length(self.devices) > 0
      error_message = "NetBox holds no kubernetes-node device at site folly; this root plans nothing against an empty NetBox."
    }
    postcondition {
      condition     = length(setsubtract(keys(local.declared), [for d in self.devices : d.name])) == 0
      error_message = "A node in clusters/folly/inventory/nodes.yaml has no NetBox device: ${join(", ", setsubtract(keys(local.declared), [for d in self.devices : d.name]))}. For a new node, comment `atlantis apply -d terraform/netbox/folly`, then plan this root again."
    }
  }
}
