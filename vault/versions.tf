provider "vault" {
  address         = "https://vault-x2fp5oyaaa-nn.a.run.app"
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
      version = "~> 3.5"
    }
  }
}
