terraform {
  backend "gcs" {
    bucket = "homelab-ng"
    prefix = "terraform/unifi"
  }
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.1"
    }
    unifi = {
      # overridden in ~/.terraformrc
      source  = "ubiquiti-community/unifi"
      version = "~> 0.41"
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


provider "onepassword" {
  # export OP_SERVICE_ACCOUNT_TOKEN=$(op item get 'Service Account Auth Token: Nixos' --fields=token --account=pulsifer --vault=ib23znjeikv74p37f6mbfk7uya --reveal)
}

provider "cloudflare" {
  # export CLOUDFLARE_API_TOKEN=$(op item get 'Cloudflare' --fields='api token [terraform]' --account=pulsifer --vault=ib23znjeikv74p37f6mbfk7uya --reveal)
  api_token = ephemeral.onepassword_item.cloudflare_api_token.password
}

provider "unifi" {
  username = "terraform"
  password = ephemeral.onepassword_item.unifi.password
  # password = "" or UNIFI_PASSWORD env
  # export UNIFI_PASSWORD=$(op item get 'unifi terraform user' --fields=password --account=pulsifer --vault=ib23znjeikv74p37f6mbfk7uya --reveal)
  api_url        = ephemeral.onepassword_item.unifi.url
  allow_insecure = true
  site           = "default"
}

# terraform apply -target=unifi_user.import
# data "unifi_user" "import" {
#   mac = "b4:8a:0a:27:07:f4"
# }

# output "import" {
#   value = data.unifi_user.import.id
# }
