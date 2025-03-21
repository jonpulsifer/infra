locals {
  project                   = "homelab-ng"
  region                    = "northamerica-northeast2"
  zone                      = join("-", [local.region, "a"])
  terraform_service_account = "terraform@${local.project}.iam.gserviceaccount.com"
}

data "google_service_account_access_token" "terraform" {
  target_service_account = local.terraform_service_account
  scopes = [
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/admin.directory.domain",
    "https://www.googleapis.com/auth/admin.directory.group",
    "https://www.googleapis.com/auth/apps.groups.settings",
  ]
}

provider "google" {
  project                     = local.project
  region                      = local.region
  zone                        = local.zone
  impersonate_service_account = local.terraform_service_account
}

provider "googleworkspace" {
  customer_id     = "C042vfhik"
  service_account = local.terraform_service_account
  access_token    = data.google_service_account_access_token.terraform.access_token
}

terraform {
  backend "gcs" {
    bucket = "homelab-ng"
    prefix = "terraform/workspace"
  }
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    googleworkspace = {
      source  = "hashicorp/googleworkspace"
      version = "~> 0.7"
    }
  }
}
