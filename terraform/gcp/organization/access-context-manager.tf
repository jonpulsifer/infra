locals {
  access_policy = "accessPolicies/236464686378"
  # cloud@pulsifer.ca
  cloud_group_key = "026in1rg22v6mdo"
}

resource "google_access_context_manager_gcp_user_access_binding" "cloud" {
  organization_id = data.google_organization.org.org_id
  group_key       = local.cloud_group_key

  scoped_access_settings {
    scope {
      client_scope {
        restricted_client_application {
          name = "Google Cloud SDK"
        }
      }
    }
    active_settings {
      access_levels = ["${local.access_policy}/accessLevels/Canada"]
      session_settings {
        session_length         = "604800s"
        session_length_enabled = true
        session_reauth_method  = "LOGIN"
        use_oidc_max_age       = false
      }
    }
  }

  scoped_access_settings {
    scope {
      client_scope {
        restricted_client_application {
          name = "Cloud Console"
        }
      }
    }
    active_settings {
      access_levels = ["${local.access_policy}/accessLevels/Canada"]
    }
  }
}

import {
  to = google_access_context_manager_gcp_user_access_binding.cloud
  id = "organizations/5046617773/gcpUserAccessBindings/aAQS-YRQlODfjNEVJp-o2JAGw9LFiCVlOrSZdwAQ5B0A8RD14"
}
