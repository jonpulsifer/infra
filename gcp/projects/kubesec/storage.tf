resource "google_storage_bucket" "cloud-lab" {
  name                        = "cloud-lab"
  location                    = "US"
  uniform_bucket_level_access = "true"
  website {
    main_page_suffix = "index.html"
    not_found_page   = "404.html"
  }
}

data "google_iam_policy" "gcs-cloud-lab" {
  binding {
    role = "roles/storage.admin"
    members = [
      "group:cloud@pulsifer.ca",
      "serviceAccount:821879192255@cloudbuild.gserviceaccount.com",
    ]
  }
}

# :D
resource "google_storage_bucket_iam_policy" "gcs-cloud-lab" {
  bucket      = google_storage_bucket.cloud-lab.name
  policy_data = data.google_iam_policy.gcs-cloud-lab.policy_data
}
