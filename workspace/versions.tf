locals {
  project                   = "homelab-ng"
  region                    = "northamerica-northeast2"
  zone                      = join("-", [local.region, "a"])
  terraform_service_account = "terraform@${local.project}.iam.gserviceaccount.com"
  terraform_workspace_admin = "terraform@pulsifer.ca"
}

data "google_service_account_access_token" "terraform" {
  target_service_account = local.terraform_service_account
  scopes = [
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/cloud-platform",
  ]
}

provider "google" {
  project                     = local.project
  region                      = local.region
  zone                        = local.zone
  impersonate_service_account = local.terraform_service_account
}

provider "googleworkspace" {
  customer_id             = "C042vfhik"
  impersonated_user_email = local.terraform_workspace_admin
  service_account         = local.terraform_service_account
  access_token            = data.google_service_account_access_token.terraform.access_token
  oauth_scopes = [
    # "https://www.googleapis.com/auth/gmail.settings.basic",
    # "https://www.googleapis.com/auth/gmail.settings.sharing",
    # "https://www.googleapis.com/auth/chrome.management.policy",
    # "https://www.googleapis.com/auth/admin.directory.customer",
    "https://www.googleapis.com/auth/admin.directory.domain",
    "https://www.googleapis.com/auth/admin.directory.group",
    # "https://www.googleapis.com/auth/admin.directory.orgunit",
    # "https://www.googleapis.com/auth/admin.directory.rolemanagement",
    # "https://www.googleapis.com/auth/admin.directory.userschema",
    # "https://www.googleapis.com/auth/admin.directory.user",
    "https://www.googleapis.com/auth/apps.groups.settings",
  ]
}

terraform {
  backend "gcs" {
    bucket = "homelab-ng"
    prefix = "terraform/workspace"
  }
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 4.29"
    }
    googleworkspace = {
      source  = "hashicorp/googleworkspace"
      version = "~> 0.7"
    }
  }
}
