resource "google_organization_iam_policy" "organization" {
  org_id      = data.google_organization.org.org_id
  policy_data = data.google_iam_policy.org.policy_data
}

# Prowler scans every project in the organization, so its read roles are bound
# once at the org node and inherited rather than repeated per project. The
# account itself is declared in terraform/gcp/projects/homelab-ng/prowler.tf;
# this policy is authoritative, so the member is spelled out rather than
# referenced across roots.
#
# Three roles, and no more: Viewer to read resource state, Service Usage Consumer
# so Prowler can ask which APIs a project has enabled and skip the checks for
# those it does not, and the custom role for the one bucket-policy permission
# Viewer omits. Notably absent is `roles/cloudasset.viewer` — that is what
# `prowler gcp --organization-id` needs to enumerate projects, and the Prowler
# App does not use it: it scans one Provider row per project.
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
