terraform {
  backend "gcs" {
    bucket = "homelab-ng"
    prefix = "terraform/cloudflare"
  }
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.1"
    }
    github = {
      source  = "integrations/github"
      version = "~> 6.0"
    }
    onepassword = {
      source  = "1password/onepassword"
      version = "~> 2.0"
    }
    null = {
      source  = "hashicorp/null"
      version = "~> 3.2.1"
    }
  }
}

locals {
  vault_id = "ib23znjeikv74p37f6mbfk7uya"
}

data "onepassword_item" "cloudflare_api_token" {
  vault = local.vault_id
  uuid  = "3x5gu5niywi6iza3jxxny7ifsy"
}

provider "cloudflare" {
  # export CLOUDFLARE_API_TOKEN=$(op item get 'Cloudflare' --fields='api token [terraform]' --vault=ib23znjeikv74p37f6mbfk7uya --reveal)
  api_token = data.onepassword_item.cloudflare_api_token.password
}
