resource "google_workflows_workflow" "base_updater" {
  name            = "atolla"
  description     = "Atolla the Magic Jellyfish Image Updater"
  service_account = google_service_account.base_updater.id
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
