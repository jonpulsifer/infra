# bluenose

`bluenose` is Spindrift's home GCP project and default shared vessel. Terraform
owns the project boundary, services, vessel VPC, private service connection,
source archive bucket, and runtime identity. Spindrift owns resources it deploys
inside that boundary.

The project does not contain build artifacts or signing keys. Those stay in
`trusted-builds`, with narrowly scoped cross-project IAM.
