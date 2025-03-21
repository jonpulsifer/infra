locals {
  project = "trusted-builds"
  region  = "northamerica-northeast1"
  zone    = join("-", [local.region, "a"])
}
data "google_project" "current" {
  project_id = local.project
}
provider "google" {
  impersonate_service_account = "terraform@homelab-ng.iam.gserviceaccount.com"
  project                     = local.project
  region                      = local.region
  zone                        = local.zone
}

provider "google-beta" {
  impersonate_service_account = "terraform@homelab-ng.iam.gserviceaccount.com"
  project                     = local.project
  region                      = local.region
  zone                        = local.zone
}

terraform {
  backend "gcs" {
    bucket = "homelab-ng"
    prefix = "terraform/trusted-builds"
  }

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.26.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 6.26.0"
    }
  }
  required_version = ">= 1.2.0"
}
