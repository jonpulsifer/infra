resource "google_project_iam_member" "ddnsbot" {
  project = "homelab-ng"
  role    = "roles/dns.admin"
  member  = google_service_account.ddns.member
}

resource "google_project_iam_member" "ddnsd" {
  project = "homelab-ng"
  role    = "roles/dns.admin"
  member  = google_service_account.ddnsd.member
}

resource "google_project_iam_member" "vault" {
  project = "homelab-ng"
  role    = "organizations/5046617773/roles/readOnlyVault"
  member  = google_service_account.vault.member
}

resource "google_service_account" "ddnsd" {
  account_id = "ddnsd-id"
}

data "google_iam_policy" "ddnsd_token_creator" {
  binding {
    role    = "roles/iam.serviceAccountTokenCreator"
    members = [google_service_account.ddnsd.member]
  }
}

resource "google_service_account_iam_policy" "ddnsd_token_creator" {
  service_account_id = google_service_account.ddnsd.name
  policy_data        = data.google_iam_policy.ddnsd_token_creator.policy_data
}

resource "google_service_account" "ddns" {
  account_id = "ddns-function"
}

resource "google_service_account" "vault" {
  account_id = "vault-id"
}

data "google_iam_policy" "github_actions" {
  binding {
    role = "roles/iam.workloadIdentityUser"
    members = [
      "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.homelab.name}/attribute.repository_owner/jonpulsifer"
    ]
  }
}

resource "google_service_account" "github_actions" {
  account_id   = "github-actions"
  display_name = "GitHub Actions Robot"
}

resource "google_service_account_iam_policy" "github_actions" {
  service_account_id = google_service_account.github_actions.name
  policy_data        = data.google_iam_policy.github_actions.policy_data
}

resource "google_project_iam_member" "github_actions_function_admin" {
  project = "homelab-ng"
  role    = "roles/cloudfunctions.admin"
  member  = google_service_account.github_actions.member
}

resource "google_service_account" "view_counter" {
  account_id   = "view-counter"
  display_name = "View Counter Cloud Function"
}

resource "google_service_account_iam_member" "github_actions_view_counter" {
  service_account_id = google_service_account.view_counter.name
  role               = "roles/iam.serviceAccountUser"
  member             = google_service_account.github_actions.member
}

resource "google_project_iam_member" "view_counter_firestore" {
  project = "homelab-ng"
  role    = "roles/datastore.user"
  member  = google_service_account.view_counter.member
}

resource "google_service_account" "terraform" {
  account_id   = "terraform"
  display_name = "Terraform Robot"
}

data "google_iam_policy" "terraform_token_creator" {
  binding {
    role    = "roles/iam.serviceAccountTokenCreator"
    members = [google_service_account.terraform.member, format("group:%s", "cloud@pulsifer.ca")]
  }

  binding {
    role    = "roles/iam.serviceAccountUser"
    members = [format("group:%s", "cloud@pulsifer.ca")]
  }
}

resource "google_service_account_iam_policy" "terraform_token_creator" {
  service_account_id = google_service_account.terraform.name
  policy_data        = data.google_iam_policy.terraform_token_creator.policy_data
}
