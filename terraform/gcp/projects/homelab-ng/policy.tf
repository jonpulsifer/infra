# allUsers needs this :(
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

resource "google_org_policy_policy" "allow_all_services" {
  name   = "projects/${local.project}/policies/serviceuser.services"
  parent = "projects/${local.project}"
  spec {
    inherit_from_parent = false
    rules {
      allow_all = "TRUE"
    }
  }
}

# cloudfunctions needs to create the project@appspot.gserviceaccount.com account
resource "google_org_policy_policy" "allow_service_accounts" {
  name   = "projects/${local.project}/policies/iam.disableServiceAccountCreation"
  parent = "projects/${local.project}"
  spec {
    rules {
      enforce = "FALSE"
    }
  }
}

# datadog needs keys
resource "google_org_policy_policy" "allow_service_account_keys" {
  name   = "projects/${local.project}/policies/iam.disableServiceAccountKeyCreation"
  parent = "projects/${local.project}"
  spec {
    rules {
      enforce = "FALSE"
    }
  }
}

resource "google_org_policy_policy" "allow_functions_without_vpc_connector" {
  name   = "projects/${local.project}/policies/cloudfunctions.requireVPCConnector"
  parent = "projects/${local.project}"
  spec {
    inherit_from_parent = false
    rules {
      enforce = "FALSE"
    }
  }
}

resource "google_org_policy_policy" "allowed_functions_vpc_connector_egress_settings" {
  name   = "projects/${local.project}/policies/cloudfunctions.allowedVpcConnectorEgressSettings"
  parent = "projects/${local.project}"
  spec {
    inherit_from_parent = false
    rules {
      allow_all = "TRUE"
    }
  }
}

resource "google_org_policy_policy" "allowed_functions_ingress_settings" {
  name   = "projects/${local.project}/policies/cloudfunctions.allowedIngressSettings"
  parent = "projects/${local.project}"
  spec {
    inherit_from_parent = false
    rules {
      allow_all = "TRUE"
    }
  }
}

resource "google_org_policy_policy" "allowed_cloud_build_worker_pools" {
  name   = "projects/${local.project}/policies/cloudbuild.allowedWorkerPools"
  parent = "projects/${local.project}"
  spec {
    inherit_from_parent = false
    rules {
      allow_all = "TRUE"
    }
  }
}

resource "google_org_policy_policy" "allowed_storage_retention_policy_seconds" {
  name   = "projects/${local.project}/policies/storage.retentionPolicySeconds"
  parent = "projects/${local.project}"
  spec {
    inherit_from_parent = false
    rules {
      allow_all = "TRUE"
    }
  }
}

resource "google_org_policy_policy" "allowed_cloud_run_vpc_egress" {
  name   = "projects/${local.project}/policies/run.allowedVPCEgress"
  parent = "projects/${local.project}"
  spec {
    inherit_from_parent = false
    rules {
      allow_all = "TRUE"
    }
  }
}

resource "google_org_policy_policy" "allowed_cloud_run_ingress" {
  name   = "projects/${local.project}/policies/run.allowedIngress"
  parent = "projects/${local.project}"
  spec {
    inherit_from_parent = false
    rules {
      allow_all = "TRUE"
    }
  }
}

resource "google_org_policy_policy" "allowed_cloud_run_binauthz" {
  name   = "projects/${local.project}/policies/run.allowedBinaryAuthorizationPolicies"
  parent = "projects/${local.project}"
  spec {
    inherit_from_parent = false
    rules {
      allow_all = "TRUE"
    }
  }
}

resource "google_org_policy_policy" "allowed_workload_identity_providers" {
  name   = "projects/${local.project}/policies/iam.workloadIdentityPoolProviders"
  parent = "projects/${local.project}"
  spec {
    inherit_from_parent = false
    rules {
      values {
        allowed_values = [
          "is:https://token.actions.githubusercontent.com",
          "is:https://oidc.vercel.com/jonpulsifers-projects"
        ]
      }
    }
  }
}

resource "google_org_policy_policy" "allowed_locations" {
  name   = "projects/${local.project}/policies/gcp.resourceLocations"
  parent = "projects/${local.project}"
  spec {
    inherit_from_parent = true
    rules {
      values {
        allowed_values = [
          "in:us-east1-locations" # free tier compute engine
        ]
      }
    }
  }
}
