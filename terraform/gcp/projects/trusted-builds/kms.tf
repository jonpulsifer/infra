resource "google_kms_key_ring" "keys" {
  name     = "keys"
  location = local.region
}

resource "google_kms_crypto_key" "signer" {
  name     = "signer"
  key_ring = google_kms_key_ring.keys.id
  purpose  = "ASYMMETRIC_SIGN"

  version_template {
    algorithm = "RSA_SIGN_PKCS1_4096_SHA512"
  }

  lifecycle {
    prevent_destroy = true
  }
}

# `signerVerifier` rather than `signer`, for the one permission between them
# that signing actually needs: `cloudkms.cryptoKeyVersions.viewPublicKey`.
#
# `roles/cloudkms.signer` is `useToSign` and nothing else, which is enough for a
# caller that already knows what it is signing with. Cosign does not: it reads
# the key's public half to learn the algorithm before it can choose a digest,
# and reads it again to verify what it just made. Binary Authorization's
# `sign-and-create` does the same. So the role that sounds exactly right refuses
# every one of them at the first call, and the failure names a permission rather
# than a role.
#
# The `useToVerify` this also grants is not incidental: the same key is the one
# admission re-checks against, on both the registry signature and the
# attestation.
resource "google_kms_crypto_key_iam_binding" "signer" {
  crypto_key_id = google_kms_crypto_key.signer.id
  role          = "roles/cloudkms.signerVerifier"
  members       = local.attester_principals
}

# The third permission signing needs, and the last one: `cloudkms.cryptoKeys.
# get`.
#
# Before it can sign anything, cosign reads the key itself to learn its default
# hash function — the key is `RSA_SIGN_PKCS1_4096_SHA512`, and nothing on the
# command line says so. `signerVerifier` grants use of the *versions* and sight
# of their public halves, and not `get` on the key they hang off, so signing
# stopped one call short of the one that matters:
#
#     signing digest: getting fetching default hash function: rpc error:
#     code = PermissionDenied desc = Permission 'cloudkms.cryptoKeys.get' denied
#
# `roles/cloudkms.viewer` is metadata only — get and list on the key and its
# versions, no use of either — so this adds reading and no capability. It also
# makes `cryptoKeyVersions.list` answer, which is how the attestation step finds
# the enabled version rather than falling back to assuming the first.
resource "google_kms_crypto_key_iam_binding" "signer_metadata" {
  crypto_key_id = google_kms_crypto_key.signer.id
  role          = "roles/cloudkms.viewer"
  members       = local.attester_principals
}
# The home vessel's SIGNER_KEY probe asks a different question from signing:
# not "may I use this key" but "does a key with the signing purpose exist
# here" — and it starts by enumerating the rings (`GET /v1/projects/…/
# keyRings`, `cloud-discovery.ts`), which is `cloudkms.keyRings.list` at
# project scope. A ring-scoped grant answers the second call and not the
# first, so the viewer sits on the project: metadata only — list and get on
# rings, keys and versions, use of nothing. The attester bindings above stay
# authoritative over the roles that can sign.
resource "google_project_iam_member" "spindrift_probe_viewer" {
  project = local.project
  role    = "roles/cloudkms.viewer"
  member  = local.spindrift_controller_member
}
