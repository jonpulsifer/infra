# ---------------------------------------------------------------------------
# Data sources: look up all devices by hostname to avoid hardcoded IDs
# ---------------------------------------------------------------------------

data "tailscale_devices" "all" {
  # No filter — fetches the full device list. Individual lookups below
  # are preferred for clarity and explicit dependencies.
}

# Individual device data sources keyed by hostname.
# These are used to drive authorization, key, and tag resources below.
# Terraform will only call the Tailscale API for data sources that are
# actually referenced by a resource, so referencing all of them is safe
# even if some are not yet in the tailnet.

data "tailscale_device" "device_800g2" {
  name = "800g2"
}

data "tailscale_device" "atomic" {
  name = "atomic"
}

data "tailscale_device" "chromebook_a288" {
  name = "Chromebook_A288"
}

data "tailscale_device" "cloudpi4" {
  name = "cloudpi4"
}

data "tailscale_device" "craftbook_air" {
  name = "Craftbook Air"
}

data "tailscale_device" "desktop_g7i75ls" {
  name = "DESKTOP-G7I75LS"
}

data "tailscale_device" "folly_k8s_lan_router_0" {
  name = "folly-k8s-lan-router-0"
}

data "tailscale_device" "folly_k8s_lan_router_0_npazfyuw" {
  name = "folly-k8s-lan-router-0" # appears twice in tailnet with different IDs
}

data "tailscale_device" "homepi4" {
  name = "homepi4"
}

data "tailscale_device" "localhost" {
  name = "localhost"
}

data "tailscale_device" "nuc" {
  name = "nuc"
}

data "tailscale_device" "offsite_k8s_lan_router_0" {
  name = "offsite-k8s-lan-router-0"
}

data "tailscale_device" "oldboy" {
  name = "oldboy"
}

data "tailscale_device" "oldschool" {
  name = "oldschool"
}

data "tailscale_device" "optiplex" {
  name = "optiplex"
}

data "tailscale_device" "retrofit" {
  name = "retrofit"
}

data "tailscale_device" "riptide" {
  name = "riptide"
}

data "tailscale_device" "rosie" {
  name = "rosie"
}

data "tailscale_device" "spore" {
  name = "spore"
}

data "tailscale_device" "tailscale_operator_1" {
  name = "tailscale-operator"
}

data "tailscale_device" "tailscale_operator_2" {
  name = "tailscale-operator" # appears twice in tailnet with different IDs
}

data "tailscale_device" "tailscale_operator_3" {
  name = "tailscale-operator" # appears three times in tailnet with different IDs
}

data "tailscale_device" "tallboy" {
  name = "tallboy"
}

data "tailscale_device" "tinytower" {
  name = "tinytower"
}

data "tailscale_device" "weatherpi4" {
  name = "weatherpi4"
}

# ---------------------------------------------------------------------------
# Device authorizations
# All devices are authorized; chaining from data source ensures we look up
# by name and never hardcode IDs in resource blocks.
# ---------------------------------------------------------------------------

resource "tailscale_device_authorization" "device_800g2" {
  device_id  = data.tailscale_device.device_800g2.id
  authorized = true
}

resource "tailscale_device_authorization" "atomic" {
  device_id  = data.tailscale_device.atomic.id
  authorized = true
}

resource "tailscale_device_authorization" "chromebook_a288" {
  device_id  = data.tailscale_device.chromebook_a288.id
  authorized = true
}

resource "tailscale_device_authorization" "cloudpi4" {
  device_id  = data.tailscale_device.cloudpi4.id
  authorized = true
}

resource "tailscale_device_authorization" "craftbook_air" {
  device_id  = data.tailscale_device.craftbook_air.id
  authorized = true
}

resource "tailscale_device_authorization" "desktop_g7i75ls" {
  device_id  = data.tailscale_device.desktop_g7i75ls.id
  authorized = true
}

resource "tailscale_device_authorization" "folly_k8s_lan_router_0" {
  device_id  = data.tailscale_device.folly_k8s_lan_router_0.id
  authorized = true
}

resource "tailscale_device_authorization" "folly_k8s_lan_router_0_npazfyuw" {
  device_id  = data.tailscale_device.folly_k8s_lan_router_0_npazfyuw.id
  authorized = true
}

resource "tailscale_device_authorization" "homepi4" {
  device_id  = data.tailscale_device.homepi4.id
  authorized = true
}

resource "tailscale_device_authorization" "localhost" {
  device_id  = data.tailscale_device.localhost.id
  authorized = true
}

resource "tailscale_device_authorization" "nuc" {
  device_id  = data.tailscale_device.nuc.id
  authorized = true
}

resource "tailscale_device_authorization" "offsite_k8s_lan_router_0" {
  device_id  = data.tailscale_device.offsite_k8s_lan_router_0.id
  authorized = true
}

resource "tailscale_device_authorization" "oldboy" {
  device_id  = data.tailscale_device.oldboy.id
  authorized = true
}

resource "tailscale_device_authorization" "oldschool" {
  device_id  = data.tailscale_device.oldschool.id
  authorized = true
}

resource "tailscale_device_authorization" "optiplex" {
  device_id  = data.tailscale_device.optiplex.id
  authorized = true
}

resource "tailscale_device_authorization" "retrofit" {
  device_id  = data.tailscale_device.retrofit.id
  authorized = true
}

resource "tailscale_device_authorization" "riptide" {
  device_id  = data.tailscale_device.riptide.id
  authorized = true
}

resource "tailscale_device_authorization" "rosie" {
  device_id  = data.tailscale_device.rosie.id
  authorized = true
}

resource "tailscale_device_authorization" "spore" {
  device_id  = data.tailscale_device.spore.id
  authorized = true
}

resource "tailscale_device_authorization" "tailscale_operator_1" {
  device_id  = data.tailscale_device.tailscale_operator_1.id
  authorized = true
}

resource "tailscale_device_authorization" "tailscale_operator_2" {
  device_id  = data.tailscale_device.tailscale_operator_2.id
  authorized = true
}

resource "tailscale_device_authorization" "tailscale_operator_3" {
  device_id  = data.tailscale_device.tailscale_operator_3.id
  authorized = true
}

resource "tailscale_device_authorization" "tallboy" {
  device_id  = data.tailscale_device.tallboy.id
  authorized = true
}

resource "tailscale_device_authorization" "tinytower" {
  device_id  = data.tailscale_device.tinytower.id
  authorized = true
}

resource "tailscale_device_authorization" "weatherpi4" {
  device_id  = data.tailscale_device.weatherpi4.id
  authorized = true
}

# ---------------------------------------------------------------------------
# Device keys: controls key expiry
# ---------------------------------------------------------------------------

resource "tailscale_device_key" "device_800g2" {
  device_id           = data.tailscale_device.device_800g2.id
  key_expiry_disabled = true
}

resource "tailscale_device_key" "atomic" {
  device_id           = data.tailscale_device.atomic.id
  key_expiry_disabled = true
}

resource "tailscale_device_key" "chromebook_a288" {
  device_id           = data.tailscale_device.chromebook_a288.id
  key_expiry_disabled = false
}

resource "tailscale_device_key" "cloudpi4" {
  device_id           = data.tailscale_device.cloudpi4.id
  key_expiry_disabled = true
}

resource "tailscale_device_key" "craftbook_air" {
  device_id           = data.tailscale_device.craftbook_air.id
  key_expiry_disabled = false
}

resource "tailscale_device_key" "desktop_g7i75ls" {
  device_id           = data.tailscale_device.desktop_g7i75ls.id
  key_expiry_disabled = true
}

resource "tailscale_device_key" "folly_k8s_lan_router_0" {
  device_id           = data.tailscale_device.folly_k8s_lan_router_0.id
  key_expiry_disabled = true
}

resource "tailscale_device_key" "folly_k8s_lan_router_0_npazfyuw" {
  device_id           = data.tailscale_device.folly_k8s_lan_router_0_npazfyuw.id
  key_expiry_disabled = true
}

resource "tailscale_device_key" "homepi4" {
  device_id           = data.tailscale_device.homepi4.id
  key_expiry_disabled = true
}

resource "tailscale_device_key" "localhost" {
  device_id           = data.tailscale_device.localhost.id
  key_expiry_disabled = false
}

resource "tailscale_device_key" "nuc" {
  device_id           = data.tailscale_device.nuc.id
  key_expiry_disabled = true
}

resource "tailscale_device_key" "offsite_k8s_lan_router_0" {
  device_id           = data.tailscale_device.offsite_k8s_lan_router_0.id
  key_expiry_disabled = true
}

resource "tailscale_device_key" "oldboy" {
  device_id           = data.tailscale_device.oldboy.id
  key_expiry_disabled = false
}

resource "tailscale_device_key" "oldschool" {
  device_id           = data.tailscale_device.oldschool.id
  key_expiry_disabled = true
}

resource "tailscale_device_key" "optiplex" {
  device_id           = data.tailscale_device.optiplex.id
  key_expiry_disabled = true
}

resource "tailscale_device_key" "retrofit" {
  device_id           = data.tailscale_device.retrofit.id
  key_expiry_disabled = true
}

resource "tailscale_device_key" "riptide" {
  device_id           = data.tailscale_device.riptide.id
  key_expiry_disabled = true
}

resource "tailscale_device_key" "rosie" {
  device_id           = data.tailscale_device.rosie.id
  key_expiry_disabled = false
}

resource "tailscale_device_key" "spore" {
  device_id           = data.tailscale_device.spore.id
  key_expiry_disabled = true
}

resource "tailscale_device_key" "tailscale_operator_1" {
  device_id           = data.tailscale_device.tailscale_operator_1.id
  key_expiry_disabled = true
}

resource "tailscale_device_key" "tailscale_operator_2" {
  device_id           = data.tailscale_device.tailscale_operator_2.id
  key_expiry_disabled = true
}

resource "tailscale_device_key" "tailscale_operator_3" {
  device_id           = data.tailscale_device.tailscale_operator_3.id
  key_expiry_disabled = true
}

resource "tailscale_device_key" "tallboy" {
  device_id           = data.tailscale_device.tallboy.id
  key_expiry_disabled = true
}

resource "tailscale_device_key" "tinytower" {
  device_id           = data.tailscale_device.tinytower.id
  key_expiry_disabled = false
}

resource "tailscale_device_key" "weatherpi4" {
  device_id           = data.tailscale_device.weatherpi4.id
  key_expiry_disabled = true
}

# ---------------------------------------------------------------------------
# Device tags: chain from data source lookups.
# Only devices that should have tags are included.
# ---------------------------------------------------------------------------

resource "tailscale_device_tags" "device_800g2" {
  device_id = data.tailscale_device.device_800g2.id
  tags      = ["tag:folly"]
}

resource "tailscale_device_tags" "desktop_g7i75ls" {
  device_id = data.tailscale_device.desktop_g7i75ls.id
  tags      = ["tag:offsite"]
}

resource "tailscale_device_tags" "folly_k8s_lan_router_0" {
  device_id = data.tailscale_device.folly_k8s_lan_router_0.id
  tags      = ["tag:folly", "tag:k8s", "tag:k8s-folly"]
}

resource "tailscale_device_tags" "folly_k8s_lan_router_0_npazfyuw" {
  device_id = data.tailscale_device.folly_k8s_lan_router_0_npazfyuw.id
  tags      = ["tag:folly", "tag:k8s", "tag:k8s-folly"]
}

resource "tailscale_device_tags" "nuc" {
  device_id = data.tailscale_device.nuc.id
  tags      = ["tag:folly"]
}

resource "tailscale_device_tags" "offsite_k8s_lan_router_0" {
  device_id = data.tailscale_device.offsite_k8s_lan_router_0.id
  tags      = ["tag:k8s", "tag:k8s-offsite", "tag:offsite"]
}

resource "tailscale_device_tags" "oldschool" {
  device_id = data.tailscale_device.oldschool.id
  tags      = ["tag:offsite"]
}

resource "tailscale_device_tags" "optiplex" {
  device_id = data.tailscale_device.optiplex.id
  tags      = ["tag:folly"]
}

resource "tailscale_device_tags" "retrofit" {
  device_id = data.tailscale_device.retrofit.id
  tags      = ["tag:offsite"]
}

resource "tailscale_device_tags" "riptide" {
  device_id = data.tailscale_device.riptide.id
  tags      = ["tag:folly"]
}

resource "tailscale_device_tags" "spore" {
  device_id = data.tailscale_device.spore.id
  tags      = ["tag:folly"]
}

resource "tailscale_device_tags" "tailscale_operator_1" {
  device_id = data.tailscale_device.tailscale_operator_1.id
  tags      = ["tag:k8s-operator"]
}

resource "tailscale_device_tags" "tailscale_operator_2" {
  device_id = data.tailscale_device.tailscale_operator_2.id
  tags      = ["tag:k8s-operator"]
}

resource "tailscale_device_tags" "tailscale_operator_3" {
  device_id = data.tailscale_device.tailscale_operator_3.id
  tags      = ["tag:k8s-operator"]
}
