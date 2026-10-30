# The machines: each node in clusters/folly/inventory/nodes.yaml with its
# model's defaults, and its lifecycle status, which NetBox holds. A node NetBox
# does not hold yet is planned.
locals {
  inventory = yamldecode(file("${path.module}/../inventory/nodes.yaml"))
  declared = { for name, n in local.inventory.nodes : name => merge(
    { for k, v in local.inventory.models[n.model] : k => v if contains(["disk", "tpm", "amt", "secure_boot"], k) },
    n,
  ) }
  node_status = { for d in data.netbox_devices.nodes.devices : d.name => d.status }
  machines = { for name, m in local.declared : name => merge(m, {
    status = lookup(local.node_status, name, "planned")
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
}
