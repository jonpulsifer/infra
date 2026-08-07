# The vessel shape every Spindrift project repeats, applied to this one.
# bluenose is the home vessel, so iam.tf carries the extras only it has.

locals {
  # As a derived string rather than google_service_account.spindrift_controller.member:
  # the module enables iam.googleapis.com, which the controller service account
  # depends on, so referencing the resource here would be a cycle. On a
  # greenfield home vessel the first apply creates the account partway through
  # and converges on the second — bluenose is long past that.
  controller_member = "serviceAccount:spindrift-controller@${local.project}.iam.gserviceaccount.com"
}

module "vessel" {
  source = "../../../modules/spindrift-vessel"

  project           = local.project
  controller_member = local.controller_member
  services          = local.vessel_services
  controller_roles  = local.spindrift_project_roles
}

module "network" {
  source = "../../../modules/vessel-network"

  project     = local.project
  region      = local.region
  subnet_cidr = local.vessel_topology.subnet_cidr

  providers = {
    google       = google
    google.quota = google.bluenose_quota
  }

  depends_on = [module.vessel]
}

# The refactor that introduced the two modules, recorded so state follows the
# code. Everything below is the same resource under a new address; a plan that
# shows anything but moves here is wrong.

moved {
  from = google_project_service.service
  to   = module.vessel.google_project_service.service
}

moved {
  from = google_service_account.spindrift_runtime
  to   = module.vessel.google_service_account.runtime
}

moved {
  from = google_service_account_iam_member.spindrift_act_as_runtime
  to   = module.vessel.google_service_account_iam_member.controller_acts_as_runtime
}

moved {
  from = google_project_iam_member.spindrift_runtime_secret_reader
  to   = module.vessel.google_project_iam_member.runtime_secret_reader
}

moved {
  from = google_project_iam_custom_role.bucket_lister
  to   = module.vessel.google_project_iam_custom_role.bucket_lister
}

moved {
  from = google_project_iam_member.spindrift_bucket_lister
  to   = module.vessel.google_project_iam_member.controller_bucket_lister
}

moved {
  from = google_project_iam_member.spindrift
  to   = module.vessel.google_project_iam_member.controller
}

moved {
  from = google_binary_authorization_policy.spindrift
  to   = module.vessel.google_binary_authorization_policy.vessel
}

moved {
  from = google_org_policy_policy.require_cloud_run_binary_authorization
  to   = module.vessel.google_org_policy_policy.require_binary_authorization
}

moved {
  from = google_compute_network.vessel
  to   = module.network.google_compute_network.vessel
}

moved {
  from = google_compute_subnetwork.vessel
  to   = module.network.google_compute_subnetwork.vessel
}

moved {
  from = google_compute_global_address.private_services
  to   = module.network.google_compute_global_address.private_services
}

moved {
  from = google_service_networking_connection.private_services
  to   = module.network.google_service_networking_connection.private_services
}
