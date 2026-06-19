locals {
  repo = "i"
}

resource "google_cloudbuild_trigger" "base_updater" {
  name        = "base-updater"
  description = "base updater trigger"
  source_to_build {
    repo_type = "GITHUB"
    ref       = "refs/heads/main"
    uri       = "https://github.com/jonpulsifer/containers"
  }
  build {
    step {
      id   = "build-updater"
      name = "gcr.io/cloud-builders/docker"
      args = ["build", "-t", "updater", "-f", "builder.Dockerfile", "."]
      dir  = "base"
    }
    step {
      wait_for = ["build-updater"]
      id       = "fetch-rootfs"
      name     = "updater"
      args     = ["make", "rootfs"]
      dir      = "base"
    }

    artifacts {
      objects {
        location = "${google_storage_bucket.trusted_artifacts.url}/ubuntu/rootfs/"
        paths    = ["base/build/ubuntu-jammy-oci-amd64-root.tar.gz", "base/build/current"]
      }
    }

    options {
      source_provenance_hash = ["SHA256"]
      # requested_verify_option = "NOT_VERIFIED" # $$$$
    }
  }
}

resource "google_cloudbuild_trigger" "containers_pr" {
  name = "containers-pr"

  github {
    owner = "jonpulsifer"
    name  = "containers"
    pull_request {
      branch          = "^main$"
      comment_control = "COMMENTS_ENABLED_FOR_EXTERNAL_CONTRIBUTORS_ONLY"
    }
  }

  build {
    step {
      id   = "apko"
      dir  = "apko"
      name = "gcr.io/cloud-builders/docker"
      args = [
        "build",
        "-t", "${local.region}-docker.pkg.dev/$PROJECT_ID/${local.repo}/apko:latest",
        "-t", "${local.region}-docker.pkg.dev/$PROJECT_ID/${local.repo}/apko:$COMMIT_SHA",
        "."
      ]
    }

    images = [
      "${local.region}-docker.pkg.dev/$PROJECT_ID/${local.repo}/apko:latest",
      "${local.region}-docker.pkg.dev/$PROJECT_ID/${local.repo}/apko:$COMMIT_SHA",
    ]
  }

  // If this is set on a build, it will become pending when it is run, 
  // and will need to be explicitly approved to start.
  approval_config {
    approval_required = true
  }
}
