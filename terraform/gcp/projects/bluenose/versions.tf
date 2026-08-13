locals {
  project = "bluenose"
  region  = "northamerica-northeast1"

  vessel_topology = jsondecode(file("${path.module}/config/vessel-topology.json"))

  # The pool every cluster workload federates through, one provider per cluster.
  # Declared in terraform/gcp/projects/homelab-ng/workload-identity.tf.
  fml_pool = "iam.googleapis.com/projects/629296473058/locations/global/workloadIdentityPools/fml-pool"
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

# Nothing in configuration uses this alias any more — it exists so the state
# can destroy the Private Service Access connection that was created through
# it, which Terraform refuses to do once the provider configuration is gone.
# Remove this block after the apply that destroys
# module.network.google_service_networking_connection.private_services.
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
