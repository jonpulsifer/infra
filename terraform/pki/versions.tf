terraform {
  backend "gcs" {
    bucket = "homelab-ng"
    prefix = "terraform/pki"
  }
  required_providers {
    onepassword = {
      source  = "1Password/onepassword"
      version = "~> 3.0"
    }
    # The OpenTofu fork adds max_path_length to tls_locally_signed_cert. It is
    # published only on the OpenTofu registry, so this root needs tofu.
    tls = {
      source  = "opentofu/tls"
      version = "~> 4.3"
    }
  }
}

# Authenticates with OP_SERVICE_ACCOUNT_TOKEN, or OP_ACCOUNT for a local sign-in.
# The op CLI must be on PATH.
provider "onepassword" {}
