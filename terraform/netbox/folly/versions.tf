terraform {
  required_version = ">= 1.11"
  backend "gcs" {
    bucket = "homelab-ng"
    prefix = "terraform/netbox/folly"
  }
  required_providers {
    # 5.8 lists NetBox 4.5.10, which capsule runs, among its tested versions.
    # 6.0 supports only NetBox 4.6.8 and later.
    netbox = {
      source  = "e-breuninger/netbox"
      version = "~> 5.8"
    }
    # Writes a device's declared custom fields with a PATCH of typed JSON.
    # netbox_device sends custom fields as strings, which NetBox refuses for
    # boolean and integer fields, and sends back on every update the values
    # it last read, which would overwrite the fields the services own.
    restapi = {
      source  = "Mastercard/restapi"
      version = "~> 3.0"
    }
    # Fills the password the provider requires of an API-only user.
    random = {
      source  = "hashicorp/random"
      version = "~> 3.7"
    }
    onepassword = {
      source  = "1Password/onepassword"
      version = "~> 3.0"
    }
  }
}

locals {
  # The vault the Atlantis 1Password service account reads.
  vault_id = "ib23znjeikv74p37f6mbfk7uya"

  # NetBox on capsule serves its API on capsule's Anchor network address,
  # which NetBox's ALLOWED_HOSTS admits (nix/services/netbox.nix).
  netbox_url = "http://${local.anchor_topology.CAPSULE_IP}:8080"
}

# An API Credential item whose credential is a NetBox v2 token (nbt_<key>.<token>)
# of the `terraform` NetBox user, which may change devices, IP addresses,
# cables, device types, custom fields, webhooks, event rules, users and
# permissions (users.tf).
ephemeral "onepassword_item" "netbox" {
  vault = local.vault_id
  title = "netbox-folly-terraform"
}

# OP_SERVICE_ACCOUNT_TOKEN on Atlantis, or OP_ACCOUNT for the owner's sign-in.
provider "onepassword" {}

provider "netbox" {
  server_url = local.netbox_url
  api_token  = ephemeral.onepassword_item.netbox.credential
}

provider "restapi" {
  uri                  = "${local.netbox_url}/api"
  bearer_token         = ephemeral.onepassword_item.netbox.credential
  id_attribute         = "id"
  write_returns_object = true
  update_method        = "PATCH"
}
