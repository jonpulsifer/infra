locals {
  project = "trusted-builds"
  region  = "northamerica-northeast1"
}

data "google_project" "current" {
  project_id = local.project
}

provider "google" {
  impersonate_service_account = "terraform@homelab-ng.iam.gserviceaccount.com"
  project                     = local.project
  region                      = local.region
}

terraform {
  backend "gcs" {
    bucket                      = "homelab-ng"
    prefix                      = "terraform/trusted-builds"
    impersonate_service_account = "terraform@homelab-ng.iam.gserviceaccount.com"
  }

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.12.0"
    }
  }
  required_version = ">= 1.2.0"
}
