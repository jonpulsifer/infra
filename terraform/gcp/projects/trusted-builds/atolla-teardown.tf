# The atolla base-image updater, declared solely so it can be destroyed.
#
# The three resources below are retired: nothing runs them, nothing depends on
# them, and no other file in this root mentions them. They are here because
# `google_workflows_workflow` refuses to be destroyed while its own state says
# `deletion_protection = true`:
#
#     Error: cannot destroy workflow without setting deletion_protection=false
#     and running `terraform apply`
#
# The flag can only be cleared by a resource that exists in configuration, so
# clearing it and removing the resource cannot be the same apply. This file is
# the first of those two: applying it changes one boolean and destroys nothing.
# **Deleting this file is the second** — with protection off the whole set
# destroys cleanly, and that is the only thing left to do with it.
#
# The service account and the trigger come back with it rather than being
# replaced by literals. The workflow names both, and an edge Terraform can see
# is what stops it destroying either one before the update that needs them.

resource "google_service_account" "base_updater" {
  account_id = "updater"
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
    }
  }
}

resource "google_workflows_workflow" "base_updater" {
  name            = "atolla"
  description     = "Atolla the Magic Jellyfish Image Updater"
  service_account = google_service_account.base_updater.id

  # The one line this file exists to apply.
  deletion_protection = false

  source_contents = <<-EOF
  - get_remote_serial:
      call: http.get
      args:
          url: https://partner-images.canonical.com/oci/jammy/current/unpacked/build-info.txt
      result: remote_serial_response
  - get_current_serial:
      call: googleapis.storage.v1.objects.get
      args:
        bucket: ${google_storage_bucket.trusted_artifacts.name}
        object: $${text.replace_all("ubuntu/rootfs/current", "/", "%2F")}
        alt: "media"
      result: current_serial_bytes
  - decode_results:
      assign:
        - current_serial: $${text.decode(current_serial_bytes)}
        - remote_serial: $${remote_serial_response.body}
  - compare_serials:
      switch:
        - condition: $${remote_serial == current_serial}
          next: skip_build
      next: update_rootfs
  - update_rootfs:
      call: googleapis.cloudbuild.v1.projects.triggers.run
      args:
        projectId: ${local.project}
        triggerId: ${google_cloudbuild_trigger.base_updater.trigger_id}
  - end_success:
      return: $${"updated " + current_serial + " -> " + remote_serial}
  - skip_build:
      return: $${"skipping build, already up to date with " + current_serial}
  EOF
}
