resource "google_folder" "production" {
  display_name = "Production"
  parent       = data.google_organization.org.name
}

resource "google_org_policy_policy" "gcp_restrictCmekCryptoKeyProjects_production" {
  name   = "${google_folder.production.name}/policies/gcp.restrictCmekCryptoKeyProjects"
  parent = google_folder.production.name
  spec {
    inherit_from_parent = false
    rules {
      values {
        allowed_values = [format("under:%s", google_folder.production.name)]
      }
    }
  }
}


resource "google_folder" "dev" {
  display_name = "Development"
  parent       = data.google_organization.org.name
}

# "iam.serviceAccountKeyExpiryHours"
resource "google_org_policy_policy" "iam_serviceAccountKeyExpiryHours" {
  name   = "${google_folder.dev.name}/policies/iam.serviceAccountKeyExpiryHours"
  parent = google_folder.dev.name

  spec {
    rules {
      values {
        allowed_values = ["2160h"]
      }
    }
  }
}

resource "google_org_policy_policy" "gcp_restrictCmekCryptoKeyProjects_dev" {
  name   = "${google_folder.dev.name}/policies/gcp.restrictCmekCryptoKeyProjects"
  parent = google_folder.dev.name
  spec {
    inherit_from_parent = false
    rules {
      values {
        allowed_values = [format("under:%s", google_folder.dev.name)]
      }
    }
  }
}

resource "google_folder" "hidden" {
  display_name = "Hidden"
  parent       = data.google_organization.org.name
}
