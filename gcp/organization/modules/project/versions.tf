terraform {
  required_version = ">= 1.1.9"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.36.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 6.36.0"
    }
  }
}
