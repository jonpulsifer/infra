resource "google_organization_iam_policy" "organization" {
  org_id      = data.google_organization.org.org_id
  policy_data = data.google_iam_policy.org.policy_data
}

# The prowler-scanner account is declared in terraform/gcp/projects/homelab-ng/prowler.tf. The Prowler
# App scans one project per Provider row, so it needs no roles/cloudasset.viewer.
locals {
  prowler_scanner = "serviceAccount:prowler-scanner@homelab-ng.iam.gserviceaccount.com"
}

data "google_iam_policy" "org" {
  binding {
    role    = "roles/assuredworkloads.admin"
    members = ["user:jonathan@pulsifer.ca"]
  }
  binding {
    role    = "roles/viewer"
    members = [local.prowler_scanner]
  }
  # Lets Prowler skip the checks for APIs a project has not enabled.
  binding {
    role    = "roles/serviceusage.serviceUsageConsumer"
    members = [local.prowler_scanner]
  }
  binding {
    role    = google_organization_iam_custom_role.prowler_scanner.name
    members = [local.prowler_scanner]
  }
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
    role    = "roles/securitycenter.serviceAgent"
    members = ["serviceAccount:service-org-5046617773@security-center-api.iam.gserviceaccount.com", ]
  }
}
