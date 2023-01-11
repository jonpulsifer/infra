terraform {
  backend "gcs" {
    bucket = "homelab-ng"
    prefix = "terraform/cloudflare"
  }
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 3.32.0"
    }
    null = {
      source  = "hashicorp/null"
      version = "~> 3.2.1"
    }
  }
}

provider "cloudflare" {
  # CLOUDFLARE_API_TOKEN enviroment variable is required
}
