terraform {
  backend "gcs" {
    bucket = "homelab-ng"
    prefix = "terraform/tailscale"
  }

  required_providers {
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
  tailnet  = "pirate-musical.ts.net"
}

ephemeral "onepassword_item" "tailscale_oauth_client" {
  vault = local.vault_id
  uuid  = "iuvy5l7yjxcdmi2ndk5uh62gu4"
}

provider "onepassword" {}

provider "tailscale" {
  oauth_client_id     = ephemeral.onepassword_item.tailscale_oauth_client.username
  oauth_client_secret = ephemeral.onepassword_item.tailscale_oauth_client.password
  tailnet             = local.tailnet
}
