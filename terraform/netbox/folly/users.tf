# The identities behind the NetBox API tokens. Each is an API-only user: the
# provider requires a password, so a random one that nothing reads or outputs
# fills the field, and the owner mints each user's token in the UI
# (docs/platform/netbox.md). Terraform manages no token.
#
# The provider has no superuser field, so the terraform user holds object
# permissions that cover every type this root manages, users and permissions
# included. A user who can grant permissions can grant itself anything, so it
# is as powerful as an admin in practice; what it adds is a distinct name in
# NetBox's changelog.

resource "random_password" "netbox_user" {
  for_each = toset(["terraform", "fleetd"])
  length   = 64
  special  = false
}

resource "netbox_user" "terraform" {
  username = "terraform"
  password = random_password.netbox_user["terraform"].result
  active   = true
}

# fleetd honours an approved EK binding only when the terraform user made its
# newest change (homelab.fleetd.bindingAuthor in nix/services/fleetd.nix).
resource "netbox_user" "fleetd" {
  username = "fleetd"
  password = random_password.netbox_user["fleetd"].result
  active   = true
}

resource "netbox_permission" "terraform_manage" {
  name        = "terraform-manage"
  description = "Create, change and delete the objects netbox/folly manages"
  actions     = ["view", "add", "change", "delete"]
  object_types = [
    "dcim.cable",
    "dcim.device",
    "dcim.devicerole",
    "dcim.devicetype",
    "dcim.frontport",
    "dcim.rearport",
    "dcim.interface",
    "dcim.interfacetemplate",
    "dcim.macaddress",
    "dcim.manufacturer",
    "dcim.platform",
    "dcim.rack",
    "dcim.site",
    "extras.customfield",
    "extras.customfieldchoiceset",
    "extras.eventrule",
    "extras.webhook",
    "ipam.ipaddress",
    "ipam.prefix",
    "ipam.vlan",
    "users.objectpermission",
    "users.user",
  ]
  users = [tonumber(netbox_user.terraform.id)]
}

resource "netbox_permission" "terraform_read" {
  name        = "terraform-read"
  description = "Read the objects netbox/folly looks up and attaches to"
  actions     = ["view"]
  object_types = [
    "dcim.devicerole",
    "dcim.interface",
    "dcim.manufacturer",
    "dcim.platform",
    "dcim.site",
  ]
  users = [tonumber(netbox_user.terraform.id)]
}

# Exactly the calls apps/fleetd makes: it reads devices, interfaces, MAC
# addresses and a device's changelog, patches devices and an interface's
# primary MAC, adds an eth0 interface, a MAC address and journal entries, and
# deletes nothing.
resource "netbox_permission" "fleetd_read" {
  name        = "fleetd-read"
  description = "Read what fleetd looks up"
  actions     = ["view"]
  object_types = [
    "core.objectchange",
    "dcim.device",
    "dcim.interface",
    "dcim.macaddress",
    "extras.journalentry",
  ]
  users = [tonumber(netbox_user.fleetd.id)]
}

resource "netbox_permission" "fleetd_change" {
  name        = "fleetd-change"
  description = "Change the device and interface fields fleetd writes"
  actions     = ["change"]
  object_types = [
    "dcim.device",
    "dcim.interface",
  ]
  users = [tonumber(netbox_user.fleetd.id)]
}

resource "netbox_permission" "fleetd_add" {
  name        = "fleetd-add"
  description = "Add the interface, MAC address and journal entries fleetd records"
  actions     = ["add"]
  object_types = [
    "dcim.interface",
    "dcim.macaddress",
    "extras.journalentry",
  ]
  users = [tonumber(netbox_user.fleetd.id)]
}
