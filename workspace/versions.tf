locals {
  customer_id               = "C042vfhik"
  project                   = "homelab-ng"
  region                    = "northamerica-northeast2"
  zone                      = join("-", [local.region, "a"])
  terraform_service_account = "terraform@${local.project}.iam.gserviceaccount.com"
  admin_scopes = [
    "https://www.googleapis.com/auth/admin.directory.domain",
    "https://www.googleapis.com/auth/admin.directory.group",
    "https://www.googleapis.com/auth/admin.directory.user",
    "https://www.googleapis.com/auth/apps.groups.settings",
  ]
}

ephemeral "google_service_account_access_token" "terraform" {
  target_service_account = local.terraform_service_account
  scopes = concat([
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/cloud-platform",
  ], local.admin_scopes)
}

provider "google" {
  project                     = local.project
  region                      = local.region
  zone                        = local.zone
  impersonate_service_account = local.terraform_service_account
}

provider "googleworkspace" {
  customer_id     = local.customer_id
  service_account = local.terraform_service_account
  access_token    = ephemeral.google_service_account_access_token.terraform.access_token

  # Impersonate an admin account for DWD operations (managing POSIX account settings)
  impersonated_user_email = "terraform@pulsifer.ca"
  oauth_scopes = local.admin_scopes
}

terraform {
  backend "gcs" {
    bucket = "homelab-ng"
    prefix = "terraform/workspace"
  }
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.0"
    }
    googleworkspace = {
      source  = "hashicorp/googleworkspace"
      version = "~> 0.7"
    }
  }
}
