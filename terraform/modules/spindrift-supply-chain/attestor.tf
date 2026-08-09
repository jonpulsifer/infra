# Reading the latest version needs `roles/cloudkms.viewer` on the key at plan
# time — with a bring-your-own key, the caller arranges that for whatever
# identity runs the plan.
data "google_kms_crypto_key_latest_version" "signer" {
  count = local.create_attestor ? 1 : 0

  crypto_key = local.signer_key_id
}

resource "google_container_analysis_note" "provenance" {
  count = local.create_attestor ? 1 : 0

  project = var.project
  name    = "provenance"

  attestation_authority {
    hint {
      human_readable_name = "Attestation Authority: Trusted Build (Provenance)"
    }
  }
}

resource "google_binary_authorization_attestor" "provenance" {
  count = local.create_attestor ? 1 : 0

  project     = var.project
  name        = "provenance"
  description = "Ensures the image is being built in a trusted GCP project, has been built by a trusted identity, and the built artifact checksum matches the image being deployed"

  attestation_authority_note {
    note_reference = google_container_analysis_note.provenance[0].id

    public_keys {
      comment = "Spindrift signer key"

      # The name the *signer* stamps, because that is the only name admission
      # matches on: `attestations sign-and-create --keyversion-*` writes the
      # KMS key version's resource URI into the attestation as its public key
      # id, and Binary Authorization looks that string up on the attestor.
      # Leave this unset and the API invents an id no signer has ever
      # produced; the build stays green and the mismatch surfaces one deploy
      # later as `denied by attestor` on an artifact that really was attested.
      #
      # Composed, never pasted. The URI ends in `/cryptoKeyVersions/N`, so a
      # rotation moves it. `.name` is the version whose public half is
      # registered below, so the id and the PEM cannot come from different
      # versions.
      id = "//cloudkms.googleapis.com/v1/${data.google_kms_crypto_key_latest_version.signer[0].name}"

      pkix_public_key {
        public_key_pem      = data.google_kms_crypto_key_latest_version.signer[0].public_key[0].pem
        signature_algorithm = data.google_kms_crypto_key_latest_version.signer[0].public_key[0].algorithm
      }
    }
  }
}

resource "google_binary_authorization_attestor_iam_member" "viewer" {
  for_each = toset(local.create_attestor ? concat(var.attester_principals, var.attestor_viewers) : [])

  project  = google_binary_authorization_attestor.provenance[0].project
  attestor = google_binary_authorization_attestor.provenance[0].name
  role     = "roles/binaryauthorization.attestorsViewer"
  member   = each.key
}

resource "google_binary_authorization_attestor_iam_member" "verifier" {
  for_each = toset(local.create_attestor ? var.verifier_agents : [])

  project  = google_binary_authorization_attestor.provenance[0].project
  attestor = google_binary_authorization_attestor.provenance[0].name
  role     = "roles/binaryauthorization.attestorsVerifier"
  member   = each.key
}

# The note side of attesting: this principal may hang an occurrence off *that*
# authority. Creating the occurrence at all is the project-level
# `occurrences.editor` in iam.tf — a caller with one and not the other gets as
# far as signing the payload and then cannot record it.
resource "google_container_analysis_note_iam_member" "attacher" {
  for_each = toset(local.create_attestor ? var.attester_principals : [])

  project = google_container_analysis_note.provenance[0].project
  note    = google_container_analysis_note.provenance[0].name
  role    = "roles/containeranalysis.notes.attacher"
  member  = each.key
}

resource "google_container_analysis_note_iam_member" "occurrences_viewer" {
  for_each = toset(local.create_attestor ? var.verifier_agents : [])

  project = google_container_analysis_note.provenance[0].project
  note    = google_container_analysis_note.provenance[0].name
  role    = "roles/containeranalysis.notes.occurrences.viewer"
  member  = each.key
}
