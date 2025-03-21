# bigquery exports from google workspace needs this :(
resource "google_org_policy_policy" "allow_all_domains" {
  name   = "projects/${local.project}/policies/iam.allowedPolicyMemberDomains"
  parent = "projects/${local.project}"
  spec {
    inherit_from_parent = false
    rules {
      allow_all = "TRUE"
    }
  }
}

# bigquery exports from google workspace needs this :(
resource "google_org_policy_policy" "allowed_locations" {
  name   = "projects/${local.project}/policies/gcp.resourceLocations"
  parent = "projects/${local.project}"

  spec {
    inherit_from_parent = true
    rules {
      values {
        allowed_values = ["is:US"]
      }
    }
  }
}
