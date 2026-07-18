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
    # OpenTofu fork: adds max_path_length (pathLen constraint) to
    # tls_locally_signed_cert. Only published on the OpenTofu registry, so this
    # root requires the tofu binary (Atlantis runs opentofu server-wide).
    tls = {
      source  = "opentofu/tls"
      version = "~> 4.3"
    }
  }
}

# Auth: OP_SERVICE_ACCOUNT_TOKEN in Atlantis; locally either that or
# OP_ACCOUNT (desktop-app/CLI sign-in). The op CLI must be on PATH.
provider "onepassword" {}
