terraform {
  backend "gcs" {
    bucket = "homelab-ng"
    prefix = "terraform/github"
  }

  required_version = ">= 1.5.6"

  required_providers {
    github = {
      source  = "integrations/github"
      version = "~> 6.0"
    }
  }
}

# The provider reads GITHUB_TOKEN (or GH_TOKEN) from the environment. Keeping
# the bootstrap token outside Terraform avoids putting it in this repository or
# into state. Run Atlantis with the token supplied as an environment secret.
provider "github" {}
