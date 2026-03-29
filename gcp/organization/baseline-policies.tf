# Cloud Security Baseline — Organization-level policies
# https://cloud.google.com/resource-manager/docs/manage-baseline-constraints
#
# Managed constraints (.managed.) are enforced as booleans.
# Google defines and updates the specific behavior.
#
# WARNING: Managed constraints cannot be overridden at folder/project level.
# Review project-level policy overrides before applying.

# --- Managed Constraints ---

resource "google_org_policy_policy" "managed_disableServiceAccountKeyCreation" {
  name   = "${data.google_organization.org.name}/policies/iam.managed.disableServiceAccountKeyCreation"
  parent = data.google_organization.org.name
  spec {
    rules {
      enforce = "TRUE"
    }
  }
}

resource "google_org_policy_policy" "managed_disableServiceAccountKeyUpload" {
  name   = "${data.google_organization.org.name}/policies/iam.managed.disableServiceAccountKeyUpload"
  parent = data.google_organization.org.name
  spec {
    rules {
      enforce = "TRUE"
    }
  }
}

resource "google_org_policy_policy" "managed_preventPrivilegedBasicRolesForDefaultServiceAccounts" {
  name   = "${data.google_organization.org.name}/policies/iam.managed.preventPrivilegedBasicRolesForDefaultServiceAccounts"
  parent = data.google_organization.org.name
  spec {
    rules {
      enforce = "TRUE"
    }
  }
}

resource "google_org_policy_policy" "managed_allowedPolicyMembers" {
  name   = "${data.google_organization.org.name}/policies/iam.managed.allowedPolicyMembers"
  parent = data.google_organization.org.name
  spec {
    rules {
      enforce = "TRUE"
      parameters = jsonencode({
        allowedMemberSubjects = []
        allowedPrincipalSets = [
          "//cloudresourcemanager.googleapis.com/${data.google_organization.org.name}"
        ]
      })
    }
  }
}

resource "google_org_policy_policy" "managed_allowedContactDomains" {
  name   = "${data.google_organization.org.name}/policies/essentialcontacts.managed.allowedContactDomains"
  parent = data.google_organization.org.name
  spec {
    rules {
      enforce = "TRUE"
    }
  }
}

resource "google_org_policy_policy" "managed_restrictProtocolForwardingCreationForTypes" {
  name   = "${data.google_organization.org.name}/policies/compute.managed.restrictProtocolForwardingCreationForTypes"
  parent = data.google_organization.org.name
  spec {
    rules {
      enforce = "TRUE"
    }
  }
}

# --- Standard Boolean Constraints ---

resource "google_org_policy_policy" "iam_automaticIamGrantsForDefaultServiceAccounts" {
  name   = "${data.google_organization.org.name}/policies/iam.automaticIamGrantsForDefaultServiceAccounts"
  parent = data.google_organization.org.name
  spec {
    rules {
      enforce = "TRUE"
    }
  }
}

resource "google_org_policy_policy" "storage_uniformBucketLevelAccess" {
  name   = "${data.google_organization.org.name}/policies/storage.uniformBucketLevelAccess"
  parent = data.google_organization.org.name
  spec {
    rules {
      enforce = "TRUE"
    }
  }
}

resource "google_org_policy_policy" "compute_setNewProjectDefaultToZonalDNSOnly" {
  name   = "${data.google_organization.org.name}/policies/compute.setNewProjectDefaultToZonalDNSOnly"
  parent = data.google_organization.org.name
  spec {
    rules {
      enforce = "TRUE"
    }
  }
}

# --- Standard List Constraints ---

resource "google_org_policy_policy" "iam_allowedPolicyMemberDomains" {
  name   = "${data.google_organization.org.name}/policies/iam.allowedPolicyMemberDomains"
  parent = data.google_organization.org.name
  spec {
    rules {
      values {
        allowed_values = [data.google_organization.org.directory_customer_id]
      }
    }
  }
}
