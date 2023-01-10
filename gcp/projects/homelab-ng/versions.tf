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
    prefix = "terraform/homelab-ng"
  }
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 4.47.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 4.48.0"
    }
  }
  required_version = ">= 1.2.6"
}
