terraform {
  backend "gcs" {
    bucket = "homelab-ng"
    prefix = "terraform/unifi"
  }
  required_providers {
    unifi = {
      # overridden in ~/.terraformrc
      source  = "paultyng/unifi"
      version = "~> 0.39"
    }
    vault = {
      source  = "hashicorp/vault"
      version = "~> 3.11"
    }
  }
}

provider "vault" {
  # vault login -method=userpass username=lol password=$(op item get vault --fields=password --account=pulsifer)
  address            = "https://vault.lolwtf.ca"
  add_address_to_env = true
  skip_tls_verify    = false
}

provider "unifi" {
  username = "terraform"
  # password = "" or UNIFI_PASSWORD env
  # export UNIFI_PASSWORD=$(op item get 'unifi terraform user' --fields=password --account=pulsifer)
  api_url        = "https://unifi"
  allow_insecure = true
  # site = "default"
}
