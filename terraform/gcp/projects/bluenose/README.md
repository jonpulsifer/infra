# bluenose

`bluenose` is Spindrift's home GCP project and default shared vessel. Terraform
owns the project boundary, services, vessel VPC, private service connection,
source archive bucket, and runtime identity. Spindrift owns resources it deploys
inside that boundary.

The project does not contain build artifacts or signing keys. Those stay in
`trusted-builds`, with narrowly scoped cross-project IAM.

The vessel shape every Spindrift project repeats comes from
`terraform/modules/spindrift-vessel` and `terraform/modules/vessel-network`
(vessel.tf); what remains in this root is home-vessel-only. A new vessel
project is a page: backend, providers, the two lists in `services.tf` and
`iam.tf`, and the module call.
