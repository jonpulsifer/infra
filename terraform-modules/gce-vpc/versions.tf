terraform {
  required_version = ">= 1.1.9"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 4.60.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 4.59.0"
    }
  }
}
