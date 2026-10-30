# The nodes file's checks, against fixtures in testdata/ on documentation
# addresses, with every provider mocked.
mock_provider "netbox" {
  mock_resource "netbox_custom_field_choice_set" {
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

override_module {
  target = module.topology
  outputs = {
    data = { K8S_NODE_CIDR = "192.0.2.0/24", API_SERVER_IP = "192.0.2.10" }
  }
}

override_module {
  target = module.anchor_topology
  outputs = {
    data = { CAPSULE_IP = "198.51.100.1", SPORE_IP = "198.51.100.2" }
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
