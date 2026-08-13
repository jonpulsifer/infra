# bluenose

`bluenose` is Spindrift's home GCP project and default shared vessel. Terraform
owns the project boundary, services, vessel VPC, Private Service Connect
service connection policies, source archive bucket, and runtime identity.
Spindrift owns resources it deploys inside that boundary.

The project does not contain build artifacts or signing keys. Those stay in
`trusted-builds`, with narrowly scoped cross-project IAM.

The vessel shape every Spindrift project repeats comes from
`terraform/modules/spindrift-vessel` and `terraform/modules/vessel-network`
(vessel.tf); what remains in this root is home-vessel-only: the
`spindrift-controller` service account and its federation bindings (iam.tf),
the source bundle bucket (storage.tf), the Firebase project (firebase.tf),
and each cluster's read path into this project's Secret Manager (iam.tf). A
new vessel project is a page: backend, providers, the two lists in
`services.tf` and `iam.tf`, and the module call.
