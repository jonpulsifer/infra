terraform {
  backend "gcs" {
    bucket = "homelab-ng"
    # prefix kept as terraform/unifi to preserve existing GCS state (path != prefix by design)
    prefix = "terraform/unifi"
  }
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.1"
    }
    unifi = {
      source  = "ubiquiti-community/unifi"
      version = "~> 0.56"
    }
    onepassword = {
      source  = "1password/onepassword"
      version = "~> 3.0"
    }
  }
}

locals {
  vault_id = "ib23znjeikv74p37f6mbfk7uya"
}

ephemeral "onepassword_item" "cloudflare_api_token" {
  vault = local.vault_id
  uuid  = "3x5gu5niywi6iza3jxxny7ifsy"
}

ephemeral "onepassword_item" "unifi" {
  vault = local.vault_id
  uuid  = "lb532zq5efzs3y3xlfbdk2kace"
}

ephemeral "onepassword_item" "unifi_offsite" {
  vault = local.vault_id
  uuid  = "4bz2i2uy5iylsqpyib54fhm2de"
}


provider "onepassword" {
  # Reads OP_SERVICE_ACCOUNT_TOKEN from the environment.
}

provider "cloudflare" {
  api_token = ephemeral.onepassword_item.cloudflare_api_token.password
}

provider "unifi" {
  username       = "terraform"
  password       = ephemeral.onepassword_item.unifi.password
  api_url        = ephemeral.onepassword_item.unifi.url
  allow_insecure = true
  site           = "default"
}

provider "unifi" {
  alias          = "offsite"
  username       = "terraform"
  password       = ephemeral.onepassword_item.unifi_offsite.password
  api_url        = ephemeral.onepassword_item.unifi_offsite.url
  allow_insecure = true
  site           = "default"
}
