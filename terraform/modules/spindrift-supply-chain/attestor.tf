# Needs roles/cloudkms.viewer on the key at plan time. On the first apply a new key's version
# can still be PENDING_GENERATION and the apply fails; the second apply converges.
data "google_kms_crypto_key_latest_version" "signer" {
  count = (local.create_key || local.create_attestor) ? 1 : 0

  crypto_key = local.signer_key_id
}

# Verification also runs in the attestor's project, so its own Binary Authorization agent
# reads occurrences too; verifier_agents lists only vessel agents.
data "google_project" "this" {
  count = local.create_attestor ? 1 : 0

  project_id = var.project
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

      # Admission matches the key version URI that sign-and-create stamps; unset, the API
      # invents an id and attested artifacts are denied. From .name, so id and PEM share a version.
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

# Recording an attestation also needs occurrences.editor on the project, in iam.tf.
resource "google_container_analysis_note_iam_member" "attacher" {
  for_each = toset(local.create_attestor ? var.attester_principals : [])

  project = google_container_analysis_note.provenance[0].project
  note    = google_container_analysis_note.provenance[0].name
  role    = "roles/containeranalysis.notes.attacher"
  member  = each.key
}

resource "google_container_analysis_note_iam_member" "occurrences_viewer" {
  for_each = toset(local.create_attestor ? concat(
    var.verifier_agents,
    ["serviceAccount:service-${data.google_project.this[0].number}@gcp-sa-binaryauthorization.iam.gserviceaccount.com"],
  ) : [])

  project = google_container_analysis_note.provenance[0].project
  note    = google_container_analysis_note.provenance[0].name
  role    = "roles/containeranalysis.notes.occurrences.viewer"
  member  = each.key
}
