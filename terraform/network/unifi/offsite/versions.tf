terraform {
  backend "gcs" {
    bucket = "homelab-ng"
    # prefix kept as terraform/unifi/offsite to preserve existing GCS state (path != prefix by design)
    prefix = "terraform/unifi/offsite"
  }
  required_providers {
    unifi = {
      source  = "ubiquiti-community/unifi"
      version = "~> 0.55"
    }
    onepassword = {
      source  = "1password/onepassword"
      version = "~> 3.0"
    }
  }
}

locals {
  vault_id = "ib23znjeikv74p37f6mbfk7uya"
  one_day  = "24h0m0s"
}

ephemeral "onepassword_item" "unifi" {
  vault = local.vault_id
  uuid  = "4bz2i2uy5iylsqpyib54fhm2de"
}

provider "onepassword" {
  # export OP_SERVICE_ACCOUNT_TOKEN=$(op item get 'Service Account Auth Token: Nixos' --fields=token --account=pulsifer --vault=ib23znjeikv74p37f6mbfk7uya --reveal)
}

provider "unifi" {
  username       = "terraform"
  password       = ephemeral.onepassword_item.unifi.password
  api_url        = ephemeral.onepassword_item.unifi.url
  allow_insecure = true
  site           = "default"
}
