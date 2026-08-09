# bluenose

`bluenose` is a GCP project holding Secret Manager as the delivery path for
cluster secrets. This root owns the project-level org-policy overrides
(`firebase.tf`) and the read path: external-secrets on both clusters federates
through `fml-pool` to read secret versions here (`iam.tf`). The project itself
is declared in the organization root.
