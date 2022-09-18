locals {
  boolean_policies = [
    "appengine.disableCodeDownload",
    "bigquery.disableBQOmniAWS",
    "bigquery.disableBQOmniAzure",
    "clouddeploy.disableServiceLabelGeneration",
    "cloudfunctions.requireVPCConnector",
    "compute.disableAllIpv6",
    "compute.disableGlobalCloudArmorPolicy",
    "compute.disableGlobalLoadBalancing",
    "compute.disableGlobalSelfManagedSslCertificate",
    "compute.disableGuestAttributesAccess",
    "compute.disableHybridCloudIpv6",
    "compute.disableInternetNetworkEndpointGroup",
    "compute.disableNestedVirtualization",
    "compute.disableSerialPortAccess",
    "compute.disableSerialPortLogging",
    "compute.disableSshInBrowser",
    "compute.disableVpcExternalIpv6",
    "compute.disableVpcInternalIpv6",
    "compute.requireOsLogin",
    "compute.requireShieldedVm",
    "compute.restrictXpnProjectLienRemoval",
    "compute.setNewProjectDefaultToZonalDNSOnly",
    "compute.skipDefaultNetworkCreation",
    "datastream.disablePublicConnectivity",
    "essentialcontacts.disableProjectSecurityContacts",
    "firestore.requireP4SAforImportExport",
    "gcp.detailedAuditLoggingMode",
    # "gcp.disableCloudLogging",
    "iam.automaticIamGrantsForDefaultServiceAccounts",
    "iam.disableAuditLoggingExemption",
    "iam.disableServiceAccountCreation",
    "iam.disableServiceAccountKeyCreation",
    "iam.disableServiceAccountKeyUpload",
    "iam.disableWorkloadIdentityClusterCreation",
    "iam.restrictCrossProjectServiceAccountLienRemoval",
    "iap.requireGlobalIapWebDisabled",
    "iap.requireRegionalIapWebDisabled",
    "sql.disableDefaultEncryptionCreation",
    "sql.restrictAuthorizedNetworks",
    "sql.restrictPublicIp",
    "storage.publicAccessPrevention",
    "storage.uniformBucketLevelAccess",
  ]
  list_policies = [
    "cloudbuild.allowedIntegrations",
    # "cloudbuild.allowedWorkerPools",
    "cloudfunctions.allowedIngressSettings",
    "cloudfunctions.allowedVpcConnectorEgressSettings",
    # "cloudkms.allowedProtectionLevels",
    "cloudscheduler.allowedTargetTypes",
    "compute.disablePrivateServiceConnectCreationForConsumers",
    # "compute.requireVpcFlowLogs",
    "compute.restrictCloudNATUsage",
    "compute.restrictDedicatedInterconnectUsage",
    "compute.restrictLoadBalancerCreationForTypes",
    "compute.restrictNonConfidentialComputing",
    "compute.restrictPartnerInterconnectUsage",
    "compute.restrictProtocolForwardingCreationForTypes",
    "compute.restrictSharedVpcBackendServices",
    "compute.restrictSharedVpcHostProjects",
    "compute.restrictSharedVpcSubnetworks",
    "compute.restrictVpcPeering",
    "compute.restrictVpnPeerIPs",
    "compute.sharedReservationsOwnerProjects",
    "compute.storageResourceUseRestrictions",
    # "compute.trustedImageProjects",
    "compute.vmCanIpForward",
    "compute.vmExternalIpAccess",
    "essentialcontacts.allowedContactDomains",
    # "gcp.resourceLocations",
    # "gcp.restrictCmekCryptoKeyProjects",
    # "gcp.restrictNonCmekServices",
    # "gcp.restrictServiceUsage",
    # "iam.allowedPolicyMemberDomains",
    "iam.allowServiceAccountCredentialLifetimeExtension",
    "iam.workloadIdentityPoolAwsAccounts",
    "iam.workloadIdentityPoolProviders",
    "meshconfig.allowedVpcscModes",
    # resourcemanager.accessBoundaries",
    "resourcemanager.allowedExportDestinations",
    "resourcemanager.allowedImportSources",
    "resourcemanager.allowEnabledServicesForExport",
    "run.allowedBinaryAuthorizationPolicies",
    "run.allowedIngress",
    "run.allowedVPCEgress",
    # "serviceuser.services",
    # "storage.restrictAuthTypes",
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

# this only affects the Cloud Healthcare API
resource "google_org_policy_policy" "allow_cloud_logging" {
  name   = "${data.google_organization.org.name}/gcp.disableCloudLogging"
  parent = data.google_organization.org.name
  spec {
    rules {
      enforce = "FALSE"
    }
  }
}

# "storage.restrictAuthTypes"
resource "google_org_policy_policy" "storage_restrictAuthTypes" {
  name   = "${data.google_organization.org.name}/storage.restrictAuthTypes"
  parent = data.google_organization.org.name
  spec {
    rules {
      allow_all = "TRUE"
      # values {
      #   allowed_values = [
      #     "in:ALL_HMAC_SIGNED_REQUESTS",
      #     # "SERVICE_ACCOUNT_HMAC_SIGNED_REQUESTS",
      #     # "USER_ACCOUNT_HMAC_SIGNED_REQUESTS",
      #   ]
      # }
    }
  }
}

# "gcp.restrictCmekCryptoKeyProjects"
resource "google_org_policy_policy" "gcp_restrictCmekCryptoKeyProjects" {
  name   = "${data.google_organization.org.name}/gcp.restrictCmekCryptoKeyProjects"
  parent = data.google_organization.org.name
  spec {
    rules {
      allow_all = "TRUE"
    }
  }
}

# "gcp.restrictNonCmekServices"
resource "google_org_policy_policy" "gcp_restrictNonCmekServices" {
  name   = "${data.google_organization.org.name}/gcp.restrictNonCmekServices"
  parent = data.google_organization.org.name
  spec {
    rules {
      values {
        denied_values = [
          "artifactregistry.googleapis.com",
          "bigquery.googleapis.com",
          "bigtable.googleapis.com",
          "composer.googleapis.com",
          "compute.googleapis.com",
          "container.googleapis.com",
          "dataflow.googleapis.com",
          "logging.googleapis.com",
          "pubsub.googleapis.com",
          "spanner.googleapis.com",
          "sqladmin.googleapis.com",
          # "storage.googleapis.com",
        ]
      }
    }
  }
}

# "cloudkms.allowedProtectionLevels"
resource "google_org_policy_policy" "cloudkms_allowedProtectionLevels" {
  name   = "${data.google_organization.org.name}/cloudkms.allowedProtectionLevels"
  parent = data.google_organization.org.name
  spec {
    rules {
      values {
        allowed_values = [
          "SOFTWARE"
          #"HSM",
          # "EXTERNAL",
          # "EXTERNAL_VPC",
        ]
      }
    }
  }
}

# "compute.requireVpcFlowLogs"
resource "google_org_policy_policy" "compute_requireVpcflowLogs" {
  name   = "${data.google_organization.org.name}/compute.requireVpcFlowLogs"
  parent = data.google_organization.org.name
  spec {
    reset = true
    # rules {
    #   values {
    #     allowed_values = [
    #       "ESSENTIAL",     # (allows values >= 0.1 and < 0.5)
    #       "LIGHT",         # (allows values >= 0.5 and < 1.0)
    #       "COMPREHENSIVE", # (allows values == 1.0)
    #     ]
    #   }
    # }
  }
}

# "gcp.restrictServiceUsage"
resource "google_org_policy_policy" "gcp_restrictServiceUsage" {
  name   = "${data.google_organization.org.name}/gcp.restrictServiceUsage"
  parent = data.google_organization.org.name
  spec {
    rules {
      allow_all = "TRUE"
    }
  }
}
