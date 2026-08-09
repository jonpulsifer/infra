locals {
  project = "bluenose"
  region  = "northamerica-northeast1"

  # The pool every cluster workload federates through, one provider per cluster.
  # Declared in terraform/gcp/projects/homelab-ng/workload-identity.tf.
  fml_pool = "iam.googleapis.com/projects/629296473058/locations/global/workloadIdentityPools/fml-pool"
}

data "google_project" "current" {
  project_id = local.project
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

# Kept until the vessel destroy applies: module.network's Service Networking
# resources are bound to this aliased provider in state, and a destroy plan
# needs the binding present. Removed once the state is empty of them.
provider "google" {
  alias                       = "bluenose_quota"
  project                     = local.project
  region                      = local.region
  impersonate_service_account = "terraform@homelab-ng.iam.gserviceaccount.com"
  user_project_override       = true
  billing_project             = local.project
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
      version = "~> 7.43.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 7.43.0"
    }
  }
  required_version = ">= 1.11.0"
}
