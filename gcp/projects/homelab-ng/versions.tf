locals {
  project = "homelab-ng"
  region  = "northamerica-northeast1"
  zone    = join("-", [local.region, "a"])
}

provider "google" {
  impersonate_service_account = "terraform@${local.project}.iam.gserviceaccount.com"

  project = local.project
  region  = local.region
  zone    = local.zone
}

provider "google" {
  alias = "free-tier"
  impersonate_service_account = "terraform@${local.project}.iam.gserviceaccount.com"

  project = local.project
  region  = "us-east1"
  zone    = "us-east1-b"
}

provider "google-beta" {
  alias = "free-tier"
  impersonate_service_account = "terraform@${local.project}.iam.gserviceaccount.com"

  project = local.project
  region  = "us-east1"
  zone    = "us-east1-b"
}

provider "google-beta" {
  impersonate_service_account = "terraform@${local.project}.iam.gserviceaccount.com"

  project = local.project
  region  = local.region
  zone    = local.zone
}


provider "cloudflare" {
  # export CLOUDFLARE_API_TOKEN=$(op item get 'Cloudflare' --fields='api token [terraform]' --account=pulsifer --reveal)
}

terraform {
  backend "gcs" {
    bucket = "homelab-ng"
    prefix = "terraform/homelab-ng"
  }
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.10.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 7.10.0"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.3"
    }
  }
  required_version = ">= 1.2.6"
}
