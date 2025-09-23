locals {
  project = "jonpulsifer"
  region  = "northamerica-northeast1"
  zone    = join("-", [local.region, "a"])
}

data "google_client_config" "current" {}

provider "google" {
  project                     = local.project
  region                      = local.region
  zone                        = local.zone
  impersonate_service_account = "terraform@homelab-ng.iam.gserviceaccount.com"
}

terraform {
  backend "gcs" {
    bucket = "homelab-ng"
    prefix = "terraform/jonpulsifer"
  }
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.4.0"
    }
  }
  required_version = ">= 1.2.5"
}
