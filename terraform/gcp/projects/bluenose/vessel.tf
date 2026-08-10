# The vessel shape every Spindrift project repeats, applied to this one.
# bluenose is the home vessel, so iam.tf carries the extras only it has.

locals {
  # As a derived string rather than google_service_account.spindrift_controller.member:
  # the module enables iam.googleapis.com, which the controller service account
  # depends on, so referencing the resource here would be a cycle.
  #
  # The cost of breaking it this way is that the module's grants name a member
  # Terraform has not created yet. On a greenfield vessel the first apply can
  # fail on a grant to a service account that does not exist; the account is
  # created in the same apply and the second converges. That retry is the
  # procedure here, the same as the supply chain's.
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
