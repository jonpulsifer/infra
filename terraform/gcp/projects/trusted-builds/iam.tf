resource "google_project_iam_member" "spindrift_builds" {
  project = local.project
  member  = local.spindrift_controller_member
  role    = "roles/cloudbuild.builds.editor"
}

# The cloud build route's timeline is a poll of `entries.list` — the build
# service hands back a status and nothing else, so the log is read from the log
# service directly. `adapters/build/cloud-build.ts` swallows a failed log read on
# purpose, so an unauthorized poll does not fail an otherwise fine build: it
# shows an operator an empty timeline instead, which reads as a bug in Spindrift
# rather than as a missing grant. Hence this, next to the one above.
resource "google_project_iam_member" "spindrift_build_logs" {
  project = local.project
  member  = local.spindrift_controller_member
  role    = "roles/logging.viewer"
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
