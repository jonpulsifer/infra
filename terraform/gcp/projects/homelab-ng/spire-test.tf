# The SPIRE federation test, clusters/folly/apps/spire-test. Its Job uploads here as its SPIFFE ID
# through the fml-pool provider `spire`, with no service account and no key.
locals {
  spire_test_uploader = "principal://iam.googleapis.com/${google_iam_workload_identity_pool.fml.name}/subject/spiffe://lolwtf.ca/ns/spire-test/sa/uploader"
}

resource "google_storage_bucket" "spire_test" {
  name                        = join("-", [local.project, "spire-test"])
  location                    = local.region
  storage_class               = "STANDARD"
  force_destroy               = false
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  lifecycle_rule {
    condition {
      age = 7
    }
    action {
      type = "Delete"
    }
  }
}

# objectCreator only: the test proves a write, and the uploader can neither read nor delete.
data "google_iam_policy" "gcs_spire_test" {
  binding {
    role = "roles/storage.admin"
    members = [
      "group:cloud@pulsifer.ca",
    ]
  }

  binding {
    role = "roles/storage.objectCreator"
    members = [
      local.spire_test_uploader,
    ]
  }
}

resource "google_storage_bucket_iam_policy" "spire_test" {
  bucket      = google_storage_bucket.spire_test.name
  policy_data = data.google_iam_policy.gcs_spire_test.policy_data
}
