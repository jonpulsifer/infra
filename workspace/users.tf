locals {
  username = "jawn"
}

resource "googleworkspace_user" "me" {
  primary_email = "jonathan@pulsifer.ca"
  name {
    given_name  = "Jonathan"
    family_name = "Pulsifer"
  }

  posix_accounts {
    primary               = true
    username              = local.username
    uid                   = "1337"
    gid                   = "1337"
    home_directory        = "/home/${local.username}"
    shell                 = "/home/${local.username}/.nix-profile/bin/zsh"
    operating_system_type = "linux"
  }

  ssh_public_keys {
    key = <<-EOT
        ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJewr6lJtffl+uZpnWXTIE5Sd3VeytQRGXKMBv1s5R/v
    EOT
  }

  lifecycle {
    ignore_changes = [
      name,
      password,
      recovery_email,
      aliases,
      addresses,
      phones,
      organizations,
      external_ids,
    ]
  }
}

resource "googleworkspace_user" "terraform" {
  primary_email = "terraform@pulsifer.ca"
  name {
    given_name  = "HashiCorp"
    family_name = "Terraform"
  }
}

resource "googleworkspace_user" "vault" {
  primary_email = "vault@pulsifer.ca"
  name {
    given_name  = "HashiCorp"
    family_name = "Vault"
  }
}