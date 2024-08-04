locals {
  # policies as of 2024-04-20
  boolean_policies = [
    "ainotebooks.disableFileDownloads",
    "ainotebooks.disableRootAccess",
    "ainotebooks.disableTerminal",
    "ainotebooks.requireAutoUpgradeSchedule",
    "ainotebooks.restrictPublicIp",
    "appengine.disableCodeDownload",
    "bigquery.disableBQOmniAWS",
    "bigquery.disableBQOmniAzure",
    "cloudbuild.disableCreateDefaultServiceAccount",
    "clouddeploy.disableServiceLabelGeneration",
    "cloudfunctions.requireVPCConnector",
    "cloudkms.disableBeforeDestroy",
    "commerceorggovernance.disablePublicMarketplace",
    "compute.disableAllIpv6",
    "compute.disableGlobalCloudArmorPolicy",
    "compute.disableGlobalLoadBalancing",
    "compute.disableGlobalSelfManagedSslCertificate",
    "compute.disableGlobalSerialPortAccess",
    "compute.disableGuestAttributesAccess",
    "compute.disableHybridCloudIpv6",
    "compute.disableInstanceDataAccessApis",
    "compute.disableInternetNetworkEndpointGroup",
    "compute.disableNestedVirtualization",
    "compute.disableNonFIPSMachineTypes",
    "compute.disableSerialPortAccess",
    "compute.disableSerialPortLogging",
    "compute.disableSshInBrowser",
    "compute.disableVpcExternalIpv6",
    "compute.disableVpcInternalIpv6",
    "compute.enableComplianceMemoryProtection",
    "compute.requireOsLogin",
    "compute.requireShieldedVm",
    "compute.restrictXpnProjectLienRemoval",
    "compute.setNewProjectDefaultToZonalDNSOnly",
    "compute.skipDefaultNetworkCreation",
    "container.restrictNoncompliantDiagnosticDataAccess",
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
    "pubsub.enforceInTransitRegions",
    "spanner.assuredWorkloadsAdvancedServiceControls",
    "spanner.disableMultiRegionInstanceIfNoLocationSelected",
    "sql.disableDefaultEncryptionCreation",
    "sql.restrictAuthorizedNetworks",
    "sql.restrictNoncompliantDiagnosticDataAccess",
    "sql.restrictNoncompliantResourceCreation",
    # "sql.restrictPublicIp",
    "storage.publicAccessPrevention",
    "storage.secureHttpTransport",
    "storage.uniformBucketLevelAccess",
  ]
  list_policies = [
    "ainotebooks.accessMode",
    "ainotebooks.environmentOptions",
    "ainotebooks.restrictVpcNetworks",
    "appengine.runtimeDeploymentExemption",
    "cloudbuild.allowedIntegrations",
    # "cloudbuild.allowedWorkerPools",
    "cloudfunctions.allowedIngressSettings",
    "cloudfunctions.allowedVpcConnectorEgressSettings",
    "cloudfunctions.restrictAllowedGenerations",
    # "cloudkms.allowedProtectionLevels",
    "cloudkms.minimumDestroyScheduledDuration",
    "cloudscheduler.allowedTargetTypes",
    "commerceorggovernance.marketplaceServices",
    "compute.allowedVlanAttachmentEncryption",
    "compute.disablePrivateServiceConnectCreationForConsumers",
    "compute.requireSslPolicy",
    # "compute.requireVpcFlowLogs",
    "compute.restrictCloudNATUsage",
    "compute.restrictCrossProjectServices",
    "compute.restrictDedicatedInterconnectUsage",
    "compute.restrictLoadBalancerCreationForTypes",
    "compute.restrictNonConfidentialComputing",
    "compute.restrictPartnerInterconnectUsage",
    "compute.restrictPrivateServiceConnectConsumer",
    "compute.restrictPrivateServiceConnectProducer",
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
    "dataform.restrictGitRemotes",
    "essentialcontacts.allowedContactDomains",
    # "gcp.resourceLocations",
    # "gcp.restrictCmekCryptoKeyProjects",
    # "gcp.restrictNonCmekServices",
    # "gcp.restrictServiceUsage",
    # "gcp.restrictTLSVersion",
    # "iam.allowedPolicyMemberDomains",
    "iam.allowServiceAccountCredentialLifetimeExtension",
    # "iam.serviceAccountKeyExpiryHours",
    # "iam.serviceAccountKeyExposureResponse",
    "iam.workloadIdentityPoolAwsAccounts",
    "iam.workloadIdentityPoolProviders",
    "meshconfig.allowedVpcscModes",
    # "resourcemanager.accessBoundaries",
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

# apply all policies by default
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

# apply all policies by default
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
          # "projects/debian-cloud",
          "projects/ubuntu-os-cloud",
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
      values { allowed_values = ["under:${data.google_organization.org.name}"] }
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
          "aiplatform.googleapis.com",
          "artifactregistry.googleapis.com",
          "bigquery.googleapis.com",
          "bigquerydatatransfer.googleapis.com",
          "bigtable.googleapis.com",
          "cloudfunctions.googleapis.com",
          "composer.googleapis.com",
          "compute.googleapis.com",
          "container.googleapis.com",
          "dataflow.googleapis.com",
          "dataproc.googleapis.com",
          "documentai.googleapis.com",
          "file.googleapis.com",
          "firestore.googleapis.com",
          "integrations.googleapis.com",
          "logging.googleapis.com",
          "notebooks.googleapis.com",
          "pubsub.googleapis.com",
          "run.googleapis.com",
          "secretmanager.googleapis.com",
          "spanner.googleapis.com",
          "sqladmin.googleapis.com",
          # "storage.googleapis.com",
          "storagetransfer.googleapis.com",
          "workstations.googleapis.com",
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

# "iam.serviceAccountKeyExposureResponse"
resource "google_org_policy_policy" "iam_serviceAccountKeyExposureResponse" {
  name   = "${data.google_organization.org.name}/policies/iam.serviceAccountKeyExposureResponse"
  parent = data.google_organization.org.name
  spec {
    rules {
      values {
        allowed_values = ["DISABLE_KEY"]
      }
    }
  }
}
