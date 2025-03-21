resource "google_organization_iam_policy" "organization" {
  org_id      = data.google_organization.org.org_id
  policy_data = data.google_iam_policy.org.policy_data
}

data "google_iam_policy" "org" {
  binding {
    role    = "roles/owner"
    members = ["group:cloud@pulsifer.ca"]
  }
  binding {
    role    = "roles/orgpolicy.policyAdmin"
    members = ["group:cloud@pulsifer.ca"]
  }
  binding {
    role    = "roles/resourcemanager.folderAdmin"
    members = ["group:cloud@pulsifer.ca"]
  }
  binding {
    role    = "roles/resourcemanager.organizationAdmin"
    members = ["group:cloud@pulsifer.ca"]
  }
  binding {
    role    = "roles/resourcemanager.projectCreator"
    members = ["group:cloud@pulsifer.ca"]
  }
  binding {
    role    = "roles/cloudfunctions.serviceAgent"
    members = ["serviceAccount:service-org-5046617773@security-center-api.iam.gserviceaccount.com", ]
  }
  binding {
    role    = "roles/serviceusage.serviceUsageAdmin"
    members = ["serviceAccount:service-org-5046617773@security-center-api.iam.gserviceaccount.com", ]
  }
  binding {
    role    = "roles/securitycenter.serviceAgent"
    members = ["serviceAccount:service-org-5046617773@security-center-api.iam.gserviceaccount.com", ]
  }
}
