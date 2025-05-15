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
      version = "~> 7.8.0"
    }
  }
  required_version = ">= 1.5.6"
}


provider "argocd" {
  # https://github.com/grpc/grpc-go/issues/434
  # export GRPC_ENFORCE_ALPN_ENABLED=false
  use_local_config = true
}
