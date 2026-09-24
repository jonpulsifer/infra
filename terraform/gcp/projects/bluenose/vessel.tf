# The spindrift-vessel module applied to bluenose, the home vessel; iam.tf holds its extras.

locals {
  controller_member = "serviceAccount:spindrift-controller@${local.project}.iam.gserviceaccount.com"
}

module "vessel" {
  source = "../../../modules/spindrift-vessel"

  project           = local.project
  controller_member = local.controller_member
  services          = local.vessel_services
  controller_roles  = local.spindrift_project_roles

  # Created by trusted-builds' spindrift-supply-chain module; roots share no state.
  attestor = "projects/trusted-builds/attestors/provenance"

  # A grant to a missing service account fails with a 400 and is not retried. A vessel
  # project has iam.googleapis.com on before its first apply, so the account can come first.
  depends_on = [google_service_account.spindrift_controller]
}

module "network" {
  source = "../../../modules/vessel-network"

  project     = local.project
  region      = local.region
  subnet_cidr = local.vessel_topology.subnet_cidr

  depends_on = [module.vessel]
}
