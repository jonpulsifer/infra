locals {
  vault_id = "ib23znjeikv74p37f6mbfk7uya"
}

data "onepassword_item" "vault" {
  vault = local.vault_id
  uuid = "jjojlizpb5p4slytyw2a4llx3m"
}

provider "vault" {
  # vault login -method=userpass username=terraform password=$(op item get vault --fields=password --account=pulsifer --vault=ib23znjeikv74p37f6mbfk7uya --reveal)
  auth_login_userpass {
    username = data.onepassword_item.vault.username
    password = data.onepassword_item.vault.password
  }
  address            = data.onepassword_item.vault.url # VAULT_ADDR
  add_address_to_env = true
  skip_tls_verify    = true
}

terraform {
  backend "gcs" {
    bucket = "homelab-ng"
    prefix = "terraform/vault"
  }
  required_providers {
    vault = {
      source  = "hashicorp/vault"
      version = "~> 5.0"
    }
    onepassword = {
      source  = "1password/onepassword"
      version = "~> 2.0"
    }
  }
}
