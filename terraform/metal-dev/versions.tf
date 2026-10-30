# The metal dev env is gone. This file keeps the root's backend and providers, so that an
# Atlantis plan destroys what its state still holds; delete it once that apply lands.
locals {
  project = "homelab-ng"
  region  = "northamerica-northeast1"
  zone    = join("-", [local.region, "a"])
}

provider "google" {
  impersonate_service_account = "terraform@${local.project}.iam.gserviceaccount.com"

  project = local.project
  region  = local.region
  zone    = local.zone
}

provider "google-beta" {
  impersonate_service_account = "terraform@${local.project}.iam.gserviceaccount.com"

  project = local.project
  region  = local.region
  zone    = local.zone
}

terraform {
  backend "gcs" {
    bucket = "homelab-ng"
    prefix = "terraform/metal-dev"
  }
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 8.9.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 8.9.0"
    }
  }
  required_version = ">= 1.3.3"
}
