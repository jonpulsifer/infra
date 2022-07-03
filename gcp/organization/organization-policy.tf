locals {
  boolean_policies = [
    "appengine.disableCodeDownload",
    "bigquery.disableBQOmniAWS",
    "bigquery.disableBQOmniAzure",
    "cloudfunctions.requireVPCConnector",
    "compute.disableAllIpv6",
    "compute.disableGuestAttributesAccess",
    "compute.disableInternetNetworkEndpointGroup",
    "compute.disableNestedVirtualization",
    "compute.disableSerialPortAccess",
    "compute.disableSerialPortLogging",
    "compute.disableVpcExternalIpv6",
    "compute.disableVpcInternalIpv6",
    "compute.requireOsLogin",
    "compute.requireShieldedVm",
    "compute.restrictXpnProjectLienRemoval",
    "compute.setNewProjectDefaultToZonalDNSOnly",
    "compute.skipDefaultNetworkCreation",
    "datastream.disablePublicConnectivity",
    "firestore.requireP4SAforImportExport",
    "gcp.detailedAuditLoggingMode",
    // "gcp.disableCloudLogging",
    "iam.automaticIamGrantsForDefaultServiceAccounts",
    "iam.disableServiceAccountCreation",
    "iam.disableServiceAccountKeyCreation",
    "iam.disableServiceAccountKeyUpload",
    "iam.disableWorkloadIdentityClusterCreation",
    "iam.restrictCrossProjectServiceAccountLienRemoval",
    "sql.disableDefaultEncryptionCreation",
    "sql.restrictAuthorizedNetworks",
    "sql.restrictPublicIp",
    "storage.publicAccessPrevention",
    "storage.uniformBucketLevelAccess",
  ]
  list_policies = [
    # "cloudbuild.allowedWorkerPools",
    "cloudfunctions.allowedIngressSettings",
    "cloudfunctions.allowedVpcConnectorEgressSettings",
    "compute.disablePrivateServiceConnectCreationForConsumers",
    "compute.restrictCloudNATUsage",
    "compute.restrictDedicatedInterconnectUsage",
    "compute.restrictLoadBalancerCreationForTypes",
    "compute.restrictNonConfidentialComputing",
    "compute.restrictPartnerInterconnectUsage",
    "compute.restrictProtocolForwardingCreationForTypes",
    "compute.restrictSharedVpcHostProjects",
    "compute.restrictSharedVpcSubnetworks",
    "compute.restrictVpcPeering",
    "compute.restrictVpnPeerIPs",
    "compute.sharedReservationsOwnerProjects",
    "compute.storageResourceUseRestrictions",
    // "compute.trustedImageProjects",
    "compute.vmCanIpForward",
    "compute.vmExternalIpAccess",
    "essentialcontacts.allowedContactDomains",
    // "gcp.resourceLocations",
    // "iam.allowedPolicyMemberDomains",
    "iam.allowServiceAccountCredentialLifetimeExtension",
    "iam.workloadIdentityPoolAwsAccounts",
    "iam.workloadIdentityPoolProviders",
    // resourcemanager.accessBoundaries",
    "resourcemanager.allowEnabledServicesForExport",
    "resourcemanager.allowedExportDestinations",
    "resourcemanager.allowedImportSources",
    "run.allowedBinaryAuthorizationPolicies",
    "run.allowedIngress",
    "run.allowedVPCEgress",
    // "serviceuser.services",
    "storage.retentionPolicySeconds",
  ]
}

resource "google_org_policy_policy" "default_deny_boolean_constraint" {
  for_each = toset(local.boolean_policies)
  name     = "${data.google_organization.org.name}/${each.key}"
  parent   = data.google_organization.org.name
  spec {
    rules {
      enforce = "TRUE"
    }
  }
}

resource "google_org_policy_policy" "default_deny_list_constraint" {
  for_each = toset(local.list_policies)
  name     = "${data.google_organization.org.name}/${each.key}"
  parent   = data.google_organization.org.name
  spec {
    rules {
      deny_all = "TRUE"
    }
  }
}

resource "google_org_policy_policy" "restrict_iam_to_org_domain" {
  name   = "${data.google_organization.org.name}/iam.allowedPolicyMemberDomains"
  parent = data.google_organization.org.name
  spec {
    rules {
      values {
        allowed_values = [data.google_organization.org.directory_customer_id]
      }
    }
  }
}

resource "google_org_policy_policy" "allow_users_to_see_org_projects_only" {
  name   = "${data.google_organization.org.name}/resourcemanager.accessBoundaries"
  parent = data.google_organization.org.name
  spec {
    rules {
      values {
        allowed_values = [format("under:%s", data.google_organization.org.id)]
      }
    }
  }
}

resource "google_org_policy_policy" "allowed_locations" {
  name   = "${data.google_organization.org.name}/gcp.resourceLocations"
  parent = data.google_organization.org.name
  spec {
    rules {
      values {
        allowed_values = ["in:canada-locations"]
      }
    }
  }
}

resource "google_org_policy_policy" "trusted_image_projects" {
  name   = "${data.google_organization.org.name}/compute.trustedImageProjects"
  parent = data.google_organization.org.name
  spec {
    rules {
      values {
        allowed_values = [
          "projects/cos-cloud",
          "projects/trusted-builds",
        ]
      }
    }
  }
}

resource "google_org_policy_policy" "trusted_worker_pools" {
  name   = "${data.google_organization.org.name}/cloudbuild.allowedWorkerPools"
  parent = data.google_organization.org.name
  spec {
    rules {
      values {
        allowed_values = [
          "under:projects/trusted-builds",
        ]
      }
    }
  }
}

resource "google_org_policy_policy" "default_deny_services" {
  name   = "${data.google_organization.org.name}/serviceuser.services"
  parent = data.google_organization.org.name
  spec {
    rules {
      values {
        denied_values = [
          "compute.googleapis.com",
          "deploymentmanager.googleapis.com",
          "dns.googleapis.com",
          "doubleclicksearch.googleapis.com",
          "replicapool.googleapis.com",
          "replicapoolupdater.googleapis.com",
          "resourceviews.googleapis.com",
        ]
      }
    }
  }
}

// this only affects the Cloud Healthcare API
resource "google_org_policy_policy" "allow_cloud_logging" {
  name   = "${data.google_organization.org.name}/gcp.disableCloudLogging"
  parent = data.google_organization.org.name
  spec {
    rules {
      enforce = "FALSE"
    }
  }
}
