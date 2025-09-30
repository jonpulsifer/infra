locals {
  project = "wishin-app"
  region  = "northamerica-northeast2"
  zone    = join("-", [local.region, "a"])
}

provider "google" {
  project                     = local.project
  region                      = local.region
  zone                        = local.zone
  impersonate_service_account = "terraform@homelab-ng.iam.gserviceaccount.com"
}

provider "google-beta" {
  project                     = local.project
  region                      = local.region
  zone                        = local.zone
  impersonate_service_account = "terraform@homelab-ng.iam.gserviceaccount.com"
}

terraform {
  backend "gcs" {
    bucket = "homelab-ng"
    prefix = "terraform/wishin-app"
  }
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.5.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 7.5.0"
    }
  }
  required_version = ">= 1.3.3"
}
