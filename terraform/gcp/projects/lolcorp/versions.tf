locals {
  project = "lolcorp"
  region  = "northamerica-northeast2"
  zone    = join("-", [local.region, "b"])
}

provider "google" {
  project = local.project
  region  = local.region
}

provider "google-beta" {
  project = local.project
  region  = local.region
}

terraform {
  backend "gcs" {
    bucket = "homelab-ng"
    prefix = "terraform/lolcorp"
  }

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.40.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 7.40.0"
    }
  }
  required_version = ">= 1.3.3"
}
