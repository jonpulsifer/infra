resource "google_service_account" "base_updater" {
  account_id = "updater"
}

resource "google_project_iam_member" "base_updater_workflows" {
  project = local.project
  member  = google_service_account.base_updater.member
  role    = "roles/workflows.invoker"
}

resource "google_project_iam_member" "base_updater_builds" {
  project = local.project
  member  = google_service_account.base_updater.member
  role    = "roles/cloudbuild.builds.editor"
}

resource "google_project_iam_member" "spindrift_builds" {
  project = local.project
  member  = local.spindrift_controller_member
  role    = "roles/cloudbuild.builds.editor"
}

# Every principal that may sign with the attestor's key, because attesting is
# two permissions in two places and holding one of them is holding neither.
#
# `roles/containeranalysis.notes.attacher` on the note (binary-authorization.tf)
# is the note side: it says this principal may hang an occurrence off *that*
# authority. Creating the occurrence at all is a project-level permission, and
# it is this one. A caller with the first and not the second gets as far as
# signing the payload and then cannot record it.
#
# Widened from the controller alone when signing moved into the build job: the
# job holds the registry credential it just pushed with, which is what a cosign
# signature needs and what the controller does not have.
resource "google_project_iam_member" "spindrift_occurrences" {
  for_each = toset(local.attester_principals)

  project = local.project
  member  = each.key
  role    = "roles/containeranalysis.occurrences.editor"
}
