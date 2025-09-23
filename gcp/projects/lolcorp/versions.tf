locals {
  project = "lolcorp"
  region  = "northamerica-northeast2"
  zone    = join("-", [local.region, "b"])
}

provider "google" {
  project = local.project
  region  = local.region
  zone    = local.zone
}

terraform {
  backend "gcs" {
    bucket = "homelab-ng"
    prefix = "terraform/lolcorp"
  }

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.4.0"
    }
  }
  required_version = ">= 1.2.3"
}
