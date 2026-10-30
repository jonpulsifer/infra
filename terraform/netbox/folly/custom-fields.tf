resource "netbox_custom_field_choice_set" "fleet" {
  for_each = {
    talos-class    = local.classes
    bmc-type       = ["none", "amt", "redfish"]
    desired-action = ["none", "provision", "attest", "wipe"]
  }

  name          = each.key
  extra_choices = [for c in each.value : [c, c]]
}

locals {
  # Every custom field on dcim.device. Git declares talos_class, bmc_type,
  # install_disk, tpm_version, amt, secure_boot_expected and the approved EK
  # binding (devices.tf); the owner sets desired_action; talos-attest and
  # fleet-controller write the rest.
  custom_fields = {
    bios_version         = { type = "text", label = "BIOS version", group = "Hardware", weight = 100, description = "SMBIOS BIOS version the node reports" }
    sku                  = { type = "text", label = "SKU", group = "Hardware", weight = 110, description = "SMBIOS SKU number" }
    install_disk         = { type = "text", label = "Install disk", group = "Hardware", weight = 120, regex = "^/dev/", description = "The disk Talos installs to" }
    amt                  = { type = "boolean", label = "Intel AMT", group = "Hardware", weight = 130, description = "The node has Intel AMT" }
    secure_boot_expected = { type = "boolean", label = "Secure Boot expected", group = "Hardware", weight = 140, description = "The firmware state the node is expected to boot in" }
    smbios_uuid          = { type = "text", label = "SMBIOS UUID", group = "Hardware", weight = 150, description = "SMBIOS UUID of the node, written by talos-attest on an intake pass; the Talos config URL names it" }
    tpm_version          = { type = "text", label = "TPM version", group = "Identity", weight = 200, regex = "^(1\\.2|2\\.0)$", description = "TPM spec version; only 2.0 seals disks and attests" }
    approved_ek_hash     = { type = "text", label = "Approved EK hash", group = "Identity", weight = 205, regex = "^[0-9a-f]{64}$", description = "The RSA EK the nodes file approves for the node, as fleetd's EK hash: SHA-256 of its DER SubjectPublicKeyInfo. Git declares it; fleetd admits an intake only against it" }
    approved_ek_hash_ecc = { type = "text", label = "Approved EK hash (ECC)", group = "Identity", weight = 206, regex = "^[0-9a-f]{64}$", description = "The ECC EK the nodes file approves for the node, as fleetd's EK hash: SHA-256 of its DER SubjectPublicKeyInfo. Git declares it; fleetd admits an intake only against it" }
    ek_hash              = { type = "text", label = "EK hash", group = "Identity", weight = 210, regex = "^[0-9a-f]{64}$", description = "SHA-256 of the TPM endorsement key public area" }
    ek_hash_ecc          = { type = "text", label = "EK hash (ECC)", group = "Identity", weight = 215, regex = "^[0-9a-f]{64}$", description = "SHA-256 of the ECC TPM endorsement key public area" }
    ek_issuer            = { type = "text", label = "EK issuer", group = "Identity", weight = 220, description = "Issuer of the TPM endorsement key certificate" }
    ldevid_serial        = { type = "text", label = "LDevID serial", group = "Identity", weight = 230, description = "Serial of the LDevID certificate" }
    ldevid_not_after     = { type = "date", label = "LDevID not after", group = "Identity", weight = 240, description = "Expiry of the LDevID certificate" }
    lak_serial           = { type = "text", label = "LAK serial", group = "Identity", weight = 250, description = "Serial of the LAK certificate" }
    last_attested        = { type = "datetime", label = "Last attested", group = "Identity", weight = 260, description = "When the node last passed attestation" }
    attest_verdict       = { type = "text", label = "Attest verdict", group = "Identity", weight = 270, description = "attested, quarantined: <reason>, or pending-approval" }
    attest_consumed_at   = { type = "datetime", label = "Attest consumed at", group = "Identity", weight = 280, description = "When the node fetched the install config fleet-controller rendered for its last attestation" }
    pcr0_by_bios         = { type = "json", label = "PCR 0 by BIOS version", group = "Identity", weight = 290, description = "The SHA-256 PCR 0 the running node quoted under each BIOS version it reported, recorded by talos-attest; edit an entry to explain a change" }
    dbx_hash             = { type = "text", label = "dbx hash", group = "Identity", weight = 295, regex = "^[0-9a-f]{64}$", description = "The SHA-256 of the dbx variable the firmware measured at the last attestation, written by fleetd; a change raises a warning and never quarantines" }
    sbat_level           = { type = "text", label = "SBAT level", group = "Identity", weight = 296, regex = "^[0-9a-f]{64}$", description = "The SHA-256 of the SbatLevel variable shim measured at the last attestation, written by fleetd; a change raises a warning and never quarantines" }
    attested_address     = { type = "text", label = "Attested address", group = "Identity", weight = 291, description = "The boot NIC IPv4 address the node reported at its last intake pass, signed by its AK; fleet-controller dials its AMT there while it is on the bootstrap network" }
    attested_switch      = { type = "text", label = "Attested switch", group = "Identity", weight = 292, description = "The LLDP chassis ID of the switch the node reported at its last intake pass, signed by its AK" }
    attested_switch_port = { type = "text", label = "Attested switch port", group = "Identity", weight = 293, description = "The LLDP port ID the node reported at its last intake pass, signed by its AK; fleet-controller cables the node to it" }
    attested_network_at  = { type = "datetime", label = "Attested network at", group = "Identity", weight = 294, description = "When talos-attest recorded the attested address and switch port" }
    talos_class          = { type = "select", label = "Talos class", group = "Fleet", weight = 300, choice_set = "talos-class", description = "The class git declares for the node: its role and patches" }
    bmc_type             = { type = "select", label = "BMC type", group = "Fleet", weight = 310, choice_set = "bmc-type", description = "The out-of-band management the node has" }
    desired_action       = { type = "select", label = "Desired action", group = "Fleet", weight = 320, choice_set = "desired-action", default = "none", description = "What the fleet controller does next: provision (attest, wipe, install), attest, or wipe" }
    last_workflow        = { type = "text", label = "Last workflow", group = "Fleet", weight = 330, description = "The newest Workflow the fleet controller made" }
    expected_port        = { type = "integer", label = "Expected port", group = "Fleet", weight = 340, minimum = 1, description = "The switch port a stub expects its machine on; fleet-controller binds a machine off the intake port only on this port" }
  }
}

resource "netbox_custom_field" "device" {
  for_each = { for name, f in local.custom_fields : name => f if f.type != "datetime" }

  name               = each.key
  type               = each.value.type
  content_types      = ["dcim.device"]
  label              = each.value.label
  group_name         = each.value.group
  weight             = each.value.weight
  description        = each.value.description
  required           = false
  validation_regex   = lookup(each.value, "regex", null)
  validation_minimum = lookup(each.value, "minimum", null)
  default            = lookup(each.value, "default", null)
  choice_set_id      = can(each.value.choice_set) ? netbox_custom_field_choice_set.fleet[each.value.choice_set].id : null
}

# netbox_custom_field refuses the type datetime, so these go through the REST
# API. Terraform creates them on a NetBox that lacks them and never updates
# them: a change to one of these entries applies only when the field is
# created.
resource "restapi_object" "datetime_field" {
  for_each = { for name, f in local.custom_fields : name => f if f.type == "datetime" }

  path         = "/extras/custom-fields"
  create_path  = "/extras/custom-fields/"
  read_path    = "/extras/custom-fields/{id}/"
  update_path  = "/extras/custom-fields/{id}/"
  destroy_path = "/extras/custom-fields/{id}/"
  data = jsonencode({
    name         = each.key
    type         = each.value.type
    object_types = ["dcim.device"]
    label        = each.value.label
    group_name   = each.value.group
    weight       = each.value.weight
    description  = each.value.description
    required     = false
  })

  lifecycle {
    ignore_changes = all
  }
}
