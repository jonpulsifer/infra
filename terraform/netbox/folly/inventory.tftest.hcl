# The nodes file's checks, against fixtures in testdata/ on documentation
# addresses, with every provider mocked.
mock_provider "netbox" {
  mock_resource "netbox_manufacturer" { defaults = { id = "1" } }
  mock_resource "netbox_device_role" { defaults = { id = "1" } }
  mock_resource "netbox_platform" { defaults = { id = "1" } }
  mock_resource "netbox_site" { defaults = { id = "1" } }
  mock_resource "netbox_device_interface" { defaults = { id = "1" } }
  mock_data "netbox_device_type" { defaults = { id = "1" } }
  mock_resource "netbox_custom_field_choice_set" {
    defaults = { id = "1" }
  }
  mock_resource "netbox_user" {
    defaults = { id = "1" }
  }
  mock_resource "netbox_webhook" {
    defaults = { id = "1" }
  }
  mock_resource "netbox_device_type" {
    defaults = { id = "1" }
  }
  mock_resource "netbox_device" {
    defaults = { id = "1" }
  }
  mock_resource "netbox_ip_address" {
    defaults = { id = "1" }
  }
  mock_data "netbox_site" {
    defaults = { id = "1" }
  }
  mock_data "netbox_device_role" {
    defaults = { id = "1" }
  }
  mock_data "netbox_platform" {
    defaults = { id = "1" }
  }
  mock_data "netbox_manufacturers" {
    defaults = { manufacturers = [{ id = 1, name = "test", slug = "test", description = "" }] }
  }
}
mock_provider "restapi" {}
mock_provider "onepassword" {}
mock_provider "random" {}

override_module {
  target = module.topology
  outputs = {
    data = { K8S_NODE_CIDR = "192.0.2.0/24", API_SERVER_IP = "192.0.2.10" }
  }
}

override_module {
  target = module.anchor_topology
  outputs = {
    data = { CAPSULE_IP = "198.51.100.1", SPORE_IP = "198.51.100.2", ANCHOR_CIDR = "198.51.100.0/24", FUTURE_CIDR = "203.0.113.0/24", BOOTSTRAP_CIDR = "198.18.0.0/24", BOOTSTRAP_VLAN = "9" }
  }
}

# The switch and the webhook are left out: their mocks would need every
# attribute of a NetBox device.
run "accepts_approved_bindings" {
  command = plan

  plan_options {
    target = [restapi_object.declared]
  }

  variables {
    nodes_file = "testdata/valid.yaml"
  }

  assert {
    condition     = jsondecode(restapi_object.declared["one"].data).custom_fields.approved_ek_hash == "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    error_message = "A node's approved RSA EK must reach NetBox's approved_ek_hash."
  }
  assert {
    condition     = jsondecode(restapi_object.declared["two"].data).custom_fields.approved_ek_hash_ecc == "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
    error_message = "A node's approved ECC EK must reach NetBox's approved_ek_hash_ecc."
  }
  assert {
    condition     = jsondecode(restapi_object.declared["three"].data).custom_fields.approved_ek_hash == null && jsondecode(restapi_object.declared["three"].data).custom_fields.approved_ek_hash_ecc == null
    error_message = "A node without a binding must clear both approved fields."
  }
  assert {
    condition     = alltrue([for o in values(restapi_object.declared) : !contains(keys(jsondecode(o.data).custom_fields), "ek_hash") && !contains(keys(jsondecode(o.data).custom_fields), "ek_hash_ecc")])
    error_message = "Terraform must never write the EK hashes fleetd observes."
  }
}

run "grants_fleetd_no_delete" {
  command = plan

  plan_options {
    target = [netbox_permission.fleetd_read, netbox_permission.fleetd_change, netbox_permission.fleetd_add]
  }

  variables {
    nodes_file = "testdata/valid.yaml"
  }

  assert {
    condition     = alltrue([for p in [netbox_permission.fleetd_read, netbox_permission.fleetd_change, netbox_permission.fleetd_add] : !contains(p.actions, "delete")])
    error_message = "fleetd deletes nothing in NetBox, so it must hold no delete permission."
  }
}

run "rejects_a_duplicate_serial" {
  command = plan

  variables {
    nodes_file = "testdata/duplicate-serial.yaml"
  }

  expect_failures = [data.netbox_site.folly]
}

run "rejects_an_ek_approved_for_two_nodes" {
  command = plan

  variables {
    nodes_file = "testdata/reused-ek.yaml"
  }

  expect_failures = [data.netbox_site.folly]
}

run "rejects_a_malformed_ek_hash" {
  command = plan

  variables {
    nodes_file = "testdata/malformed-ek.yaml"
  }

  expect_failures = [data.netbox_site.folly]
}

run "rejects_an_unknown_binding_key" {
  command = plan

  variables {
    nodes_file = "testdata/unknown-ek-key.yaml"
  }

  expect_failures = [data.netbox_site.folly]
}

run "declares_each_install_disk_serial" {
  command = plan

  plan_options {
    target = [restapi_object.declared]
  }

  variables {
    nodes_file = "testdata/valid.yaml"
  }

  assert {
    condition     = jsondecode(restapi_object.declared["one"].data).custom_fields.install_disk_serial == "DISK-1"
    error_message = "A node's disk_serial must reach NetBox's install_disk_serial."
  }
  assert {
    condition     = jsondecode(restapi_object.declared["two"].data).custom_fields.install_disk_serial == "0123456789"
    error_message = "A quoted serial of digits must reach NetBox as the same string."
  }
  assert {
    condition     = jsondecode(restapi_object.declared["three"].data).custom_fields.install_disk_serial == null
    error_message = "A node without a disk_serial must plan, and clear install_disk_serial."
  }
}

run "rejects_a_disk_serial_two_nodes_share" {
  command = plan

  variables {
    nodes_file = "testdata/duplicate-disk-serial.yaml"
  }

  expect_failures = [data.netbox_site.folly]
}

run "rejects_a_malformed_disk_serial" {
  command = plan

  variables {
    nodes_file = "testdata/malformed-disk-serial.yaml"
  }

  expect_failures = [data.netbox_site.folly]
}

run "rejects_an_unquoted_disk_serial" {
  command = plan

  variables {
    nodes_file = "testdata/unquoted-disk-serial.yaml"
  }

  expect_failures = [data.netbox_site.folly]
}

run "rejects_a_disk_serial_on_a_model" {
  command = plan

  variables {
    nodes_file = "testdata/model-disk-serial.yaml"
  }

  expect_failures = [data.netbox_site.folly]
}

run "lab_preserves_lifecycle_and_records_both_racks" {
  command = plan
  plan_options {
    target = [restapi_object.lab_declared, netbox_rack.lab, netbox_ip_address.lab]
  }
  variables { nodes_file = "testdata/valid.yaml" }
  assert {
    condition     = alltrue([for d in restapi_object.lab_declared : !contains(keys(jsondecode(d.data)), "status") && !contains(keys(jsondecode(d.data)), "custom_fields") && !contains(keys(jsondecode(d.data)), "rack")])
    error_message = "Inventory updates must preserve lifecycle, custom fields and rack placement."
  }
  assert {
    condition     = netbox_rack.lab["folly"].u_height == 12 && netbox_rack.lab["folly"].width == 19 && netbox_rack.lab["oldschool"].u_height == 8 && netbox_rack.lab["oldschool"].width == 10
    error_message = "Each site must hold the owner's specified rack."
  }
  assert {
    condition     = netbox_ip_address.lab["retrofit"].ip_address == "${jsondecode(module.oldschool_topology.data.NODE_ADDRESSES).retrofit}/${split("/", module.oldschool_topology.data.K8S_NODE_CIDR)[1]}"
    error_message = "Oldschool node addresses must come from the offsite topology."
  }
}
