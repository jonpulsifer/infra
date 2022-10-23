terraform {
  backend "gcs" {
    bucket = "homelab-ng"
    prefix = "terraform/unifi"
  }
  required_providers {
    unifi = {
      # overridden in ~/.terraformrc
      source  = "paultyng/unifi"
      version = "~> 0.38"
    }
    vault = {
      source  = "hashicorp/vault"
      version = "~> 3.8"
    }
  }
}

provider "vault" {
  address         = "https://vault-x2fp5oyaaa-nn.a.run.app"
  skip_tls_verify = false
}

provider "unifi" {
  username = "terraform"
  # password = "" or UNIFI_PASSWORD env
  api_url        = "https://10.1.0.1"
  allow_insecure = true
  # site = "default"
}
