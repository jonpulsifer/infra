provider "vault" {
  address         = "https://vault.lolwtf.ca"
  skip_tls_verify = false
}

terraform {
  backend "gcs" {
    bucket = "homelab-ng"
    prefix = "terraform/vault"
  }
  required_providers {
    vault = {
      source  = "hashicorp/vault"
      version = "~> 4.0"
    }
  }
}
