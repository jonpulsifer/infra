# The private half of the hosted build route's `sealPublicKey`.
#
# A hosted build's inputs are readable by anyone who can see the run, so a
# stored registry credential or a build secret travels inside them sealed to
# the route's public key (`GitHubActionsBuildRoute.sealForRun`). The reusable
# workflow opens them with this key. It lives here, beside the signer, because
# the run already federates into this project to sign what it built, and the
# same principal — the build workflow at `main`, whichever repository's caller
# ran it — is the one that may read it. The platform repository's own caller
# carries a copy as a repository Actions secret and reads that first; every
# other caller has no secret store of its own and reads this.
#
# The version is added out of band: the material is the route's key pair, not
# something this root derives, and a value in state is a value in the bucket.
#   op read 'op://homelab/<item>/private key' | gcloud secrets versions add \
#     spindrift-build-seal-key --project=trusted-builds --data-file=-
resource "google_secret_manager_secret" "spindrift_build_seal_key" {
  secret_id = "spindrift-build-seal-key"

  replication {
    auto {}
  }

  depends_on = [google_project_service.service["secretmanager.googleapis.com"]]
}

resource "google_secret_manager_secret_iam_member" "spindrift_build_seal_key_accessor" {
  secret_id = google_secret_manager_secret.spindrift_build_seal_key.id
  role      = "roles/secretmanager.secretAccessor"
  member    = local.spindrift_build_workflow_principal
}
