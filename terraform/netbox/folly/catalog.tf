# The site every node is in. Its preconditions check clusters/folly/inventory/nodes.yaml,
# so a plan fails on an entry that would not apply cleanly before it reads NetBox.
data "netbox_site" "folly" {
  slug = "folly"

  lifecycle {
    precondition {
      condition     = alltrue([for n in values(local.nodes) : contains(keys(local.models), n.model)])
      error_message = "Every node's model must be a key of models in clusters/folly/inventory/nodes.yaml."
    }
    precondition {
      condition     = alltrue([for n in values(local.nodes) : contains(local.classes, n.class)])
      error_message = "Every node's class must be controlplane, worker-g5 or worker-g2."
    }
    precondition {
      condition     = alltrue([for n in values(local.nodes) : contains(local.bmc_types, n.bmc)])
      error_message = "Every node's bmc must be amt or none."
    }
    precondition {
      condition     = alltrue([for n in values(local.nodes) : n.bmc == "none" || n.amt])
      error_message = "A node with bmc amt must have amt true."
    }
    precondition {
      condition = alltrue([for n in values(local.nodes) :
      can(cidrhost("${n.address}/32", 0)) && cidrhost("${n.address}/${local.node_prefix_length}", 0) == cidrhost(local.topology.K8S_NODE_CIDR, 0)])
      error_message = "Every node's address must be inside K8S_NODE_CIDR in clusters/folly/config/cluster-topology.json."
    }
    precondition {
      condition     = contains([for n in values(local.nodes) : n.address], local.topology.API_SERVER_IP)
      error_message = "API_SERVER_IP in clusters/folly/config/cluster-topology.json must be a node's address."
    }
    precondition {
      condition     = length(distinct([for n in values(local.nodes) : n.address])) == length(local.nodes)
      error_message = "No two nodes may share an address."
    }
    precondition {
      condition     = length(distinct([for n in values(local.nodes) : n.switch_port])) == length(local.nodes)
      error_message = "No two nodes may share a switch port."
    }
    precondition {
      condition     = length(distinct([for n in values(local.nodes) : upper(n.serial)])) == length(local.nodes)
      error_message = "No two nodes may share a serial."
    }
    precondition {
      condition     = alltrue([for n in values(local.nodes) : alltrue([for k in keys(n) : contains(local.approved_ek_keys, k) if startswith(k, "approved_")])])
      error_message = "A node's approved EK binding takes only approved_ek_rsa2048 and approved_ek_eccp256."
    }
    precondition {
      condition     = alltrue([for h in local.approved_eks : can(regex("^[0-9a-f]{64}$", h))])
      error_message = "An approved EK hash must be 64 lowercase hex characters, fleetd's EK hash: the SHA-256 of the EK's DER SubjectPublicKeyInfo."
    }
    precondition {
      condition     = length(distinct(local.approved_eks)) == length(local.approved_eks)
      error_message = "No two nodes may approve the same EK."
    }
    precondition {
      condition     = alltrue([for name in keys(local.nodes) : can(regex("^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$", name)) && !startswith(name, "intake-")])
      error_message = "A node's name must be a hostname that does not start with intake-, which marks a machine NetBox has not bound."
    }
    precondition {
      condition     = alltrue([for n in values(local.nodes) : can(regex("^/dev/", n.disk)) && contains(["1.2", "2.0"], n.tpm)])
      error_message = "A node's disk must be under /dev/ and its tpm 1.2 or 2.0."
    }
    precondition {
      condition     = alltrue([for m in values(local.models) : !contains(keys(m), "disk_serial")])
      error_message = "disk_serial names one disk, so a node sets it and a model never does."
    }
    precondition {
      condition     = alltrue([for s in local.disk_serials : can(regex("^\"[A-Za-z0-9._-]{1,64}\"$", jsonencode(s)))])
      error_message = "A node's disk_serial must be a quoted string of 1 to 64 letters, digits, dots, underscores or hyphens: the serial its install disk reports."
    }
    precondition {
      condition     = length(distinct([for s in local.disk_serials : upper(s)])) == length(local.disk_serials)
      error_message = "No two nodes may share a disk_serial."
    }
  }
}

data "netbox_device_role" "node" {
  name = "kubernetes-node"
}

data "netbox_device_role" "switch" {
  name = "switch"
}

data "netbox_platform" "talos" {
  name = "Talos Linux"
}

data "netbox_manufacturers" "node" {
  for_each = toset([for m in values(local.models) : m.manufacturer])

  filter {
    name  = "slug"
    value = each.key
  }
}

# The switch the nodes' cables reach: the site's one device with the switch role.
data "netbox_devices" "switch" {
  filter {
    name  = "site_id"
    value = data.netbox_site.folly.id
  }
  filter {
    name  = "role_id"
    value = data.netbox_device_role.switch.id
  }

  lifecycle {
    postcondition {
      condition     = length(self.devices) == 1
      error_message = "NetBox's site folly must hold exactly one device with the role switch."
    }
  }
}

data "netbox_device_interfaces" "switch" {
  filter {
    name  = "device_id"
    value = data.netbox_devices.switch.devices[0].device_id
  }
}

locals {
  managed_tag  = "managed-by: git-seed"
  switch_ports = { for i in data.netbox_device_interfaces.switch.interfaces : i.name => i.id }
}

# A device type per model. Its interface template gives each new device the
# interface its cable and address go on, before any MAC is known.
resource "netbox_device_type" "node" {
  for_each = local.models

  model           = each.value.name
  slug            = each.key
  manufacturer_id = one(data.netbox_manufacturers.node[each.value.manufacturer].manufacturers).id
  u_height        = 0
  is_full_depth   = false
  tags            = [local.managed_tag]
}

resource "netbox_interface_template" "node" {
  for_each = local.models

  device_type_id = netbox_device_type.node[each.key].id
  name           = each.value.interface
  type           = "1000base-t"
}
