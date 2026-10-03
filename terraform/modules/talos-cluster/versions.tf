terraform {
  # Ephemeral resources and write-only attributes: OpenTofu 1.11+. Atlantis
  # runs the opentofu pinned in mise.toml.
  required_version = ">= 1.11"
  required_providers {
    talos = {
      source  = "siderolabs/talos"
      version = "~> 0.12"
    }
    onepassword = {
      source  = "1Password/onepassword"
      version = "~> 3.0"
    }
  }
}
