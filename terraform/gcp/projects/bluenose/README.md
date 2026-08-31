# bluenose

`bluenose` is Spindrift's home GCP project and default shared vessel. Terraform
owns the project boundary, services, vessel VPC, Private Service Connect
service connection policies, buckets, and runtime identities. Spindrift owns
resources it deploys inside that boundary. The project also holds the storage
and identity for kthx, which is not a Spindrift app and shares nothing with
one but the project.

The project does not contain build artifacts or signing keys. Those stay in
`trusted-builds`, with narrowly scoped cross-project IAM.

The vessel shape every Spindrift project repeats comes from
`terraform/modules/spindrift-vessel` and `terraform/modules/vessel-network`
(vessel.tf); what remains in this root is home-vessel-only, a file at a time —
service accounts, their federation bindings and each cluster's read path into
this project's Secret Manager in `iam.tf`, buckets and their IAM in
`storage.tf`, the Firebase project in `firebase.tf`. A new vessel project is a
page: backend, providers, the two lists in `services.tf` and `iam.tf`, and the
module call.
