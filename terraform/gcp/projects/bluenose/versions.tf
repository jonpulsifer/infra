locals {
  project = "bluenose"
  region  = "northamerica-northeast1"

  vessel_topology = jsondecode(file("${path.module}/config/vessel-topology.json"))

  spindrift_principal = "principal://iam.googleapis.com/projects/629296473058/locations/global/workloadIdentityPools/fml-pool/subject/offsite:system:serviceaccount:spindrift:spindrift"
}

data "google_project" "current" {
  project_id = local.project
}

data "google_project" "trusted_builds" {
  project_id = "trusted-builds"
}

provider "google" {
  project                     = local.project
  region                      = local.region
  impersonate_service_account = "terraform@homelab-ng.iam.gserviceaccount.com"
}

provider "google-beta" {
  project                     = local.project
  region                      = local.region
  impersonate_service_account = "terraform@homelab-ng.iam.gserviceaccount.com"
}

terraform {
  backend "gcs" {
    bucket                      = "homelab-ng"
    prefix                      = "terraform/bluenose"
    impersonate_service_account = "terraform@homelab-ng.iam.gserviceaccount.com"
  }

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.41.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 7.41.0"
    }
  }
  required_version = ">= 1.11.0"
}
