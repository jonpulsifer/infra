locals {
  project = "bluenose"
  region  = "northamerica-northeast1"

  vessel_topology = jsondecode(file("${path.module}/config/vessel-topology.json"))

  # The pool every cluster workload federates through, one provider per cluster.
  # Declared in terraform/gcp/projects/homelab-ng/workload-identity.tf.
  fml_pool = "iam.googleapis.com/projects/629296473058/locations/global/workloadIdentityPools/fml-pool"

  spindrift_principal = "principal://${local.fml_pool}/subject/offsite:system:serviceaccount:spindrift:spindrift"
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

# Service Networking otherwise charges its API request to the project that
# owns the impersonated service account, even though the consumer network and
# enabled API both belong to this vessel.
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
      version = "~> 7.42.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 7.42.0"
    }
  }
  required_version = ">= 1.11.0"
}
