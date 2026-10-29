terraform {
  backend "gcs" {
    bucket = "homelab-ng"
    # prefix kept as terraform/tailscale to preserve existing GCS state (path != prefix by design)
    prefix = "terraform/tailscale"
  }

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 8.8.0"
    }
    onepassword = {
      source  = "1password/onepassword"
      version = "~> 3.0"
    }
    tailscale = {
      source  = "tailscale/tailscale"
      version = "~> 0.29"
    }
  }
}

locals {
  vault_id = "ib23znjeikv74p37f6mbfk7uya"
  tailnet  = local.fleet.tailnet
}

ephemeral "onepassword_item" "tailscale_oauth_client" {
  vault = local.vault_id
  uuid  = "iuvy5l7yjxcdmi2ndk5uh62gu4"
}

provider "onepassword" {}

provider "google" {
  impersonate_service_account = "terraform@homelab-ng.iam.gserviceaccount.com"
  project                     = "homelab-ng"
}

provider "tailscale" {
  oauth_client_id     = ephemeral.onepassword_item.tailscale_oauth_client.username
  oauth_client_secret = ephemeral.onepassword_item.tailscale_oauth_client.password
  tailnet             = local.tailnet
}
