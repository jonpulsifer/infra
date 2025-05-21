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
      source  = "paultyng/unifi"
      version = "~> 0.41"
    }
    vault = {
      source  = "hashicorp/vault"
      version = "~> 5.0"
    }
  }
}

provider "cloudflare" {
  # export CLOUDFLARE_API_TOKEN=$(op item get 'Cloudflare' --fields='api token [terraform]' --account=pulsifer --reveal)
}


provider "unifi" {
  username = "terraform"
  # password = "" or UNIFI_PASSWORD env
  # export UNIFI_PASSWORD=$(op item get 'unifi terraform user' --fields=password --account=pulsifer --reveal)
  api_url        = "https://unifi.fml.pulsifer.ca"
  allow_insecure = true
  site           = "default"
}

provider "vault" {
  # vault login -method=userpass username=terraform password=$(op item get vault --fields=password --account=pulsifer --reveal)
  address            = "http://vault.lolwtf.ca" # VAULT_ADDR
  add_address_to_env = true
  skip_tls_verify    = true
}

# terraform apply -target=unifi_user.import
# data "unifi_user" "import" {
#   mac = "b4:8a:0a:27:07:f4"
# }

# output "import" {
#   value = data.unifi_user.import.id
# }
