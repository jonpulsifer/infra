# Project-scope grants for the build routes. These attach to var.project
# whichever posture the key and attestor are in, because they are about what
# happens in the artifacts project itself.

resource "google_project_iam_member" "controller_builds" {
  project = var.project
  role    = "roles/cloudbuild.builds.editor"
  member  = var.controller_member
}

# The cloud build route's timeline is a poll of `entries.list` — the build
# service hands back a status and nothing else, so the log is read from the
# log service directly. An unauthorized poll does not fail an otherwise fine
# build: it shows an operator an empty timeline instead, which reads as a bug
# in Spindrift rather than as a missing grant. Hence this, next to the one
# above.
resource "google_project_iam_member" "controller_build_logs" {
  project = var.project
  role    = "roles/logging.viewer"
  member  = var.controller_member
}

# The project half of attesting: creating an occurrence at all. The note-side
# `notes.attacher` (attestor.tf) says the principal may hang it off that
# authority; attesting is two permissions in two places and holding one of
# them is holding neither. With a bring-your-own attestor whose occurrences
# record in another project, the caller mirrors this grant there.
resource "google_project_iam_member" "attester_occurrences" {
  for_each = toset(var.attester_principals)

  project = var.project
  role    = "roles/containeranalysis.occurrences.editor"
  member  = each.key
}
