locals {
  username = "jawn"
}

data "onepassword_item" "google_workspace_agent_user" {
  vault = local.vault_id
  title = "Google Workspace agent user"
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

resource "googleworkspace_user" "agent" {
  primary_email = "agent@pulsifer.ca"
  password      = data.onepassword_item.google_workspace_agent_user.password

  name {
    given_name  = "Agent"
    family_name = "Account"
  }

  lifecycle {
    ignore_changes = [
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
