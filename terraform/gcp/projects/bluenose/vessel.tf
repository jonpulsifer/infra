# The vessel shape every Spindrift project repeats, applied to this one.
# bluenose is the home vessel, so iam.tf carries the extras only it has.

locals {
  # As a derived string rather than google_service_account.spindrift_controller.member:
  # the module enables iam.googleapis.com, which the controller service account
  # depends on, so referencing the resource here would be a cycle.
  #
  # A string carries no dependency edge, so nothing orders the module's grants
  # against the account they name. The `depends_on` on the module call below
  # supplies that edge in the one direction that works: the account first, then
  # everything granted to it. Granting to a service account that does not exist
  # is a 400, not a retryable eventual-consistency error, so leaving the order
  # to the graph fails every apply rather than converging on the second.
  controller_member = "serviceAccount:spindrift-controller@${local.project}.iam.gserviceaccount.com"
}

module "vessel" {
  source = "../../../modules/spindrift-vessel"

  project           = local.project
  controller_member = local.controller_member
  services          = local.vessel_services
  controller_roles  = local.spindrift_project_roles

  # roots do not share state, so the supply chain's attestor is named
  # literally rather than read from trusted-builds' output: the attestor
  # trusted-builds' spindrift-supply-chain module creates, as
  # `projects/{project}/attestors/{name}`.
  attestor = "projects/trusted-builds/attestors/provenance"

  # The edge the derived `controller_member` string cannot carry. Creating the
  # account before this project's own APIs are enabled works because a vessel
  # project has `iam.googleapis.com` on before its first apply — nothing can
  # create the service account that apply grants to otherwise.
  depends_on = [google_service_account.spindrift_controller]
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
