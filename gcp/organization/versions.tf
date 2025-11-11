locals {
  project = "homelab-ng"
  region  = "northamerica-northeast1"
  zone    = join("-", [local.region, "a"])
}

provider "google" {
  project                     = local.project
  region                      = local.region
  zone                        = local.zone
  impersonate_service_account = "terraform@${local.project}.iam.gserviceaccount.com"
}

provider "google-beta" {
  project                     = local.project
  region                      = local.region
  zone                        = local.zone
  impersonate_service_account = "terraform@${local.project}.iam.gserviceaccount.com"
}

terraform {
  backend "gcs" {
    bucket = "homelab-ng"
    prefix = "terraform/resource-manager"
  }
  required_providers {
    google = {
      source = "hashicorp/google"
      version = "~> 7.10"
    }
    google-beta = {
      source = "hashicorp/google-beta"
      version = "~> 7.10"
    }
  }
  required_version = ">= 1.8.3"
}
