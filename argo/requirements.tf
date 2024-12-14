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

terraform {
  backend "gcs" {
    bucket = "homelab-ng"
    prefix = "terraform/argo"
  }
  required_providers {
    google = {
      source = "hashicorp/google"
    }
    argocd = {
      source  = "argoproj-labs/argocd"
      version = "~> 7.2.0"
    }
  }
  required_version = ">= 1.5.6"
}


provider "argocd" {
  use_local_config = true
  grpc_web         = true
  # context = "foo" # Use explicit context from ArgoCD config instead of `current-context`.
}
